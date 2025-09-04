# On the Raspberry Pi
sudo npm i -g pm2

# From your app directory
pm2 start npm --name "oathbot" -- start

# See status and logs
pm2 status
pm2 logs oathbot

# Restart / stop / delete
pm2 restart oathbot
pm2 stop oathbot
pm2 delete oathbot

# Make it survive reboots
pm2 save
pm2 startup systemd   # run the printed command once, then:
pm2 save

# remove the process
pm2 unstartup systemd