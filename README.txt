########################
########################
######## CONFIG ########
########################
########################

1.0 - PLEASE SET PUBLICHTML TO THE LOCATION OF YOUR WEBSERVER DIR - config/config.cfg

########################
########################
######## VIDEOS ########
########################
########################

There are two sample videos included in this submission.

cd ./static

        wget https://media.xiph.org/video/derf/y4m/akiyo_qcif.y4m
        wget https://media.xiph.org/video/derf/y4m/tractor_1080p25.y4m


########################
########################
### EXAMPLE COMMANDS ###
########################
########################

IMPORTANT - RUN BOTH SCRIPTS FROM WHERE YOU DONWLOAD THE GIT REPO TO. IN THIS CASE MY FILES are located /home/james/ims. So I cd there first and execute. 
SAMPLE VIDEO FILES ARE in ./static/
SAMPLE HAR RESULTS ARE in ./results/


james@james-VirtualBox:~/IMS$ sudo ./runcode.sh -h
#################################################################################################
#                                                                                               #
# usage: runcode.sh [-fhimv]                                                                    #
# -f FFMPEG flags e.g. -f "-c:v libvpx-vp9 -t 5"                                                #
# -h This help message.                                                                         #
# -i Ignores Pre checks                                                                         #
# -m MP4Box flags:                                                                              #
#       Note "--segment-name segment_" is not necessary.                                        #
#       "-dash" can support multiple values, e.g. "-dash 1000,2000,5000"                        #
# -v Raw video file to encode                                                                   #
#                                                                                               #
# Example:                                                                                      #
# This Command says encode the first 5 seconds of akiyo_qcif.y4m with libvpx-vp9                #
# and segment with 1000ms                                                                       #
#                                                                                               #
# sudo ./runcode.sh -f "-c:v libvpx-vp9 -t 5" -i -m "-dash 1000" -v static/akiyo_qcif.y4m  	#
#                                                                                               #
#################################################################################################



###############################################################################################################################################

THE COMMAND IN THE HELP SCREEN ABOVE INCLUDING OUTPUT.

james@james-VirtualBox:~/IMS$ sudo ./runcode.sh -f "-c:v libvpx-vp9 -t 5" -i -m "-dash 1000" -v static/akiyo_qcif.y4m
##################################################################################
###################     STEP 1 - SKIPPING PRECHECKS             ##################
##################################################################################

-i flag supplied in the command line. Skipping pre checks

###################################################################################
###################     STEP 2 - GENERATING MP4                 ###################
###################################################################################

Creating mp4 video from /home/james/IMS/static/akiyo_qcif.y4m with libvpx-vp9.
FFMPEG LOG located here: /home/james/IMS/videos/ffmpeg_libvpx-vp9.output
MP4 located here: /home/james/IMS/videos/libvpx-vp9/video_libvpx-vp9.mp4

GENERATING MP4 COMPLETE

###################################################################################
###################     STEP 3 - SEGMENT AND CREATE MPD         ###################
###################################################################################

Creating 1000 ms segments and dash files
MPD and Segments are here: /home/james/IMS/videos/libvpx-vp9/seg_1000
See output from MP4box here /home/james/IMS/videos/libvpx-vp9/seg_1000/MP4Box_1000.output
myapp.js & runtest.html here /home/james/IMS/videos/libvpx-vp9/seg_1000/

SEGMENT AND CREATE MPD COMPLETE

###################################################################################
################### STEP 4 - RUN TESTS ONE AT A TIME            ###################
###################################################################################

Moving files for 1000 ms segment test into /var/www/james/public_html
Files are now in place for 1000 test.
Please connect to http://<YOUR IP>/runtest.html
Once ready you can then move onto further tests.....

RUN TESTS ONE AT A TIME COMPLETE


###############################################################################################################################################


ANALYSE SCRIPT EXAMPLE

james@james-VirtualBox:~/IMS$ ./analyse.sh -r results/test3_higherquality.har
Total Download time for all segments in ./results/test3_higherquality//test_1.csv: 1235.73
Total Download time for all segments in ./results/test3_higherquality//test_2.csv: 675.544
Total Download time for all segments in ./results/test3_higherquality//test_3.csv: 1275.54
Total Download time for all segments in ./results/test3_higherquality//test_4.csv: 185.6
