// const { token, clientId, guildId } = require('./config.json');
// Load environment variables (look for .env in project root / cwd)
require('dotenv').config();

const token = process.env.DISCORD_TOKEN;
const onlineChannelId = process.env.DISCORD_ONLINE_CHANNEL_ID;
const dailyChannelId = process.env.DISCORD_DAILY_CHANNEL_ID;

console.log('Environment check:');
console.log('Token exists:', !!token);
console.log('Online channel ID exists:', !!onlineChannelId);
console.log('Daily channel ID exists:', !!dailyChannelId);
console.log('Token length:', token ? token.length : 0);
const { Client, GatewayIntentBits } = require('discord.js');
//const jsdom = require("jsdom");
const axios = require('axios');
const cheerio = require('cheerio');  // new addition
const cron = require('node-cron');
const fs = require('fs').promises;
const path = require('path');
const express = require('express');
const levelToExperience = require('./experience_table');

// Create Express app for health checks
const app = express();
const port = process.env.PORT || 3001;

// Health check endpoint
app.get('/', (req, res) => {
    res.json({
        status: 'Bot is running!',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Start the Express server
app.listen(port, () => {
    console.log(`Health check server running on port ${port}`);
});

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

let onlineMessage = null;
let updateInterval = null;

async function ensureMessageForChannel(channelId, initialContent) {
    if (!channelId) {
        console.warn('Missing channel ID for ensureMessageForChannel');
        return null;
    }
    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel || !channel.isTextBased()) {
            console.error('Channel not found or not text-based:', channelId);
            return null;
        }
        const fetched = await channel.messages.fetch({ limit: 5 });
        const existing = fetched.find(msg => msg.author.id === client.user.id);
        if (existing) return existing;
        return await channel.send(initialContent);
    } catch (error) {
        console.error('Error ensuring message for channel', channelId, error);
        return null;
    }
}

async function updateGuildStatus() {
    if (!onlineMessage) {
        onlineMessage = await ensureMessageForChannel(onlineChannelId, '```\nSetting up guild status...```');
        if (!onlineMessage) return;
    }

    try {

        const players = await fetchAllPlayers();

        // Group players by vocation
        const groupedPlayers = players.reduce((acc, player) => {
            if (!acc[player.vocation]) {
                acc[player.vocation] = [];
            }
            // Only add online players
            if (player.status === 'Online') {
                acc[player.vocation].push(player);
            }
            return acc;
        }, {});

        // Sort players within each vocation group
        Object.keys(groupedPlayers).forEach(vocation => {
            groupedPlayers[vocation].sort((a, b) => {
                return parseInt(b.level) - parseInt(a.level);
            });
        });

        // Create formatted response
        let response = '```\n';
        let totalOnline = 0;

        Object.entries(groupedPlayers).forEach(([vocation, players]) => {
            if (players.length > 0) {
                response += `\n${vocation.toUpperCase()}\n`;
                response += 'Name'.padEnd(20) + 'Level\n';
                response += '─'.repeat(25) + '\n';

                players.forEach(player => {
                    response += `${player.name.padEnd(20)}${player.level}\n`;
                    totalOnline++;
                });
                response += '\n';
            }
        });

        // Add summary at the top
        const summary = `Online Players: ${totalOnline}\n`;
        response = summary + response + '```' + '\n' + 'Last updated: ' + currentTimestamp();

        // Check if response is too long
        if (response.length > 1900) {
            response = '```\nToo many online players to display! Please try again later.```';
        }

        await onlineMessage.edit(response);
    } catch (error) {
        console.error('Error updating guild status:', error);
        if (onlineMessage) {
            await onlineMessage.edit('```\nError updating guild status. Please try again later.```');
        }
    }
}

async function savePlayerLevels(players) {
    const data = {
        timestamp: new Date().toISOString(),
        players: players.reduce((acc, player) => {
            acc[player.name] = {
                level: parseInt(player.level),
                vocation: player.vocation
            };
            return acc;
        }, {})
    };

    await fs.writeFile(
        path.join(__dirname, 'player_levels.json'),
        JSON.stringify(data, null, 2)
    );
}

async function getYesterdayPlayerLevels() {
    try {
        const data = await fs.readFile(
            path.join(__dirname, 'player_levels.json'),
            'utf-8'
        );
        return JSON.parse(data);
    } catch (error) {
        return null;
    }
}

function currentTimestamp() {
    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const year = now.getFullYear();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    return `${month}/${day}/${year}, ${hours}:${minutes}`;
}

function getYmdInTimeZone(date, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(date);
    const partMap = {};
    for (const part of parts) {
        partMap[part.type] = part.value;
    }
    return `${partMap.year}-${partMap.month}-${partMap.day}`;
}

async function fetchAllPlayers() {
    try {
        const url = 'https://classic.dura-online.com/?guilds/Oath';
        const { data } = await axios.get(url);
        const $ = cheerio.load(data);

        let players = [];
        $('table.TableContent').each((i, table) => {
            $(table).find('tbody tr').each((j, row) => {
                const playerData = {
                    rank: $(row).find('td').eq(0).text().trim(),
                    name: $(row).find('td').eq(1).find('a').text().trim(),
                    vocation: $(row).find('td').eq(2).text().trim(),
                    level: $(row).find('td').eq(3).text().trim(),
                    status: $(row).find('td').eq(4).find('b').text().trim()
                };
                players.push(playerData);
            });
        });

        players = players.filter(player => player.name && player.level);
        let rank = '';
        for (let i = 0; i < players.length; i++) {
            if (players[i].rank == '') {
                players[i].rank = rank;
            } else if (players[i].rank != rank) {
                rank = players[i].rank;
            }
        }
        return players;
    } catch (error) {
        console.error('Error fetching players:', error);
        return [];
    }
}

async function checkLevelProgress() {

    try {
        const previousData = await getYesterdayPlayerLevels();
        const currentPlayers = await fetchAllPlayers();

        if (!previousData) {
            await savePlayerLevels(currentPlayers);
            return;
        }

        const levelChanges = [];
        currentPlayers.forEach(player => {
            const previousLevel = previousData.players[player.name]?.level;
            if (previousLevel) {
                const currentLevel = parseInt(player.level);
                const previousLevelInt = parseInt(previousLevel);
                if (currentLevel !== previousLevelInt) {
                    const experienceGained = (levelToExperience[currentLevel] ?? 0) - (levelToExperience[previousLevelInt] ?? 0);
                    levelChanges.push({
                        name: player.name,
                        previousLevel: previousLevelInt,
                        currentLevel: currentLevel,
                        levelsGained: currentLevel - previousLevelInt,
                        experienceGained: experienceGained,
                        vocation: player.vocation
                    });
                }
            }
        });

        // Sort all changes from highest gain to biggest loss
        levelChanges.sort((a, b) => b.experienceGained - a.experienceGained);

        let response = '```\nOath Level Progress Report\n';
        response += '─'.repeat(30) + '\n\n';

        levelChanges.forEach(change => {
            const changeSymbol = change.levelsGained > 0 ? '+' : '';
            response += `${change.name.padEnd(20)} ${change.previousLevel} → ${change.currentLevel} (${changeSymbol}${change.levelsGained})\n`;
        });

        if (levelChanges.length == 0) {
            response += `\nNo level changes to report.  Get grinding Oath!\n`;
        }
        response += '```';
        try {
            await fs.writeFile(
                path.join(__dirname, 'progress_report.json'),
                JSON.stringify({ timestamp: new Date().toISOString(), report: response }, null, 2)
            );
        } catch (error) {
            console.error('Error saving progress report:', error);
        }
        try {
            const channel = await client.channels.fetch(dailyChannelId);
            if (!channel || !channel.isTextBased()) {
                console.error('Daily channel not found or not text-based:', dailyChannelId);
            } else {
                await channel.send(response);
            }
        } catch (err) {
            console.error('Error sending daily progress message:', err);
        }

        await savePlayerLevels(currentPlayers);
    } catch (error) {
        console.error('Error checking level progress:', error);
    }
}

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);

    // Ensure online message exists, start interval, and run first update
    onlineMessage = await ensureMessageForChannel(onlineChannelId, '```\nSetting up guild status...```');
    if (!updateInterval) {
        updateInterval = setInterval(updateGuildStatus, 2 * 60 * 1000); // 2 minutes
    }
    await updateGuildStatus();

    // Schedule daily task (new message each time)
    cron.schedule('15 0 9 * * *', checkLevelProgress, {
        timezone: 'America/Chicago'
    });

    // Initialize daily tracking storage/run if needed
    const previousData = await getYesterdayPlayerLevels();
    const timeZone = 'America/Chicago';
    const todayYmd = getYmdInTimeZone(new Date(), timeZone);
    const lastSavedYmd = previousData?.timestamp ? getYmdInTimeZone(new Date(previousData.timestamp), timeZone) : null;

    if (lastSavedYmd && lastSavedYmd !== todayYmd) {
        await checkLevelProgress();
    } else {
        const players = await fetchAllPlayers();
        await savePlayerLevels(players);
    }
});

client.login(token);