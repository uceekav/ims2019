#!/bin/bash

## Config File
source `pwd`/config/config.cfg

usage(){

cat << EOF
#################################################################################################
#												#
# usage: runcode.sh [-fhimv]									#		
# -f FFMPEG flags e.g. -f "-c:v libvpx-vp9 -t 5"						#
# -h This help message.										#
# -i Ignores Pre checks										#
# -m MP4Box flags:										#
#	Note "--segment_name segment_" is not necessary.					#
#    	"-dash" can support multiple values, e.g. "-dash 1000,2000,5000"  			#
# -v Raw video file to encode									#
#												#
# Example:											#
# This Command says encode the first 5 seconds of akiyo_qcif.y4m with libvpx-vp9.		#
# Create two tests:										# 
#	1. Segments are 1000 ms									#		
#	2. Segments are 2000 ms 								#
#												#
# sudo ./runcode.sh -f "-c:v libvpx-vp9 -t 5" -i -m "-dash 1000,2000" -v static/akiyo_qcif.y4m	# 
#												#
#################################################################################################
EOF

}

print_line (){
echo "###################################################################################"
}

pre_checks (){

	print_line
	echo -e "###################     STEP 1 - PRECHECKS                      ###################"
	print_line

	## check ffmpeg
	which ffmpeg
	
	if [[ $? -eq 0 ]]; then
	
		## Use which ffmpeg install
		FFMPEG=`which ffmpeg`
		echo -e "\nFFMPEG PATH is: ${FFMPEG}"
	else
		echo -e "\nFFMPEG PATH is: ${FFMPEG}"
	fi

	## Shaka Dir
	echo "SHAKA DIR: $SHAKADIR"

	which MP4Box > /dev/null

	if [[ $? -ne 0 ]]; then
	
		echo "Please install MP4box"
		exit 1
	else 
		echo "MP4Box PATH is: `which MP4Box`"
	fi


	## Check apache is installed
	which apache2 > /dev/null

	if [[ $? -eq 0 ]]; then

        	## Use which ffmpeg install
        	APACHE2=`which apache2`
        	echo "APACHE PATH is: ${APACHE2}"

		## check if apache running 
		ps -ef | grep -i apache | grep -qv "grep"

		if [ $? -eq 0 ]; then
			echo "Apache is Running...."
		else
			echo "starting apache...."
			sudo /etc/init.d/apache2 start

			if [ $? -eq 0 ]; then
				echo "Apache Successfully Started"
			else
				echo "Error starting Apache. Please manaully check before resuming."
				exit 1
			fi
		fi	

	else
        	echo "Please install apache. A sample config is avaiable in ..."
		echo "Alternativel rerun this script with -a option."
		exit 1
	fi

	echo -e "\n\e[32mPRECHECKS COMPLETE\e[0m\n"

}

generate_mp4 (){

	print_line
	echo -e "###################     STEP 2 - GENERATING MP4                 ###################"
	print_line

	encoding=$ENCODING

	if [[ -z $YUVVID ]];
	then
		echo -e "\n-v is Mandatory! Exiting...."
		usage
		exit 1
	fi

	video="`pwd`/$YUVVID"

	if [[ ! -f $video ]];then
		echo -e "\n${video} does not exist"
		usage
		exit 1
	fi
	## cleanup from previous runs
	cd $VIDDIR
	rm -rf ./$encoding/* > /dev/null

	vp9="libvpx-vp9"
	x264="libx264"
	x265="libx265"

	if [[ ( "$encoding" == "$vp9" || "$encoding" == "$x264"  || "$encoding" == "$x265" ) ]];
	then
		mkdir -p $encoding
		
		cat <<-EOF

			Creating mp4 video from $video with $encoding.
			FFMPEG LOG located here: ${VIDDIR}/ffmpeg_${encoding}.output
		EOF

		$FFMPEG -i $video $FFMPEGFLAGS $encoding/video_${encoding}.mp4 &> ffmpeg_${encoding}.output

		if [[ $? -eq 0 ]];
		then
			echo "MP4 located here: ${VIDDIR}/$encoding/video_${encoding}.mp4"
		else
			echo "Error occured creating MP4. Please refer to ${VIDDIR}/ffmpeg_${encoding}.output"
		fi
	else
		echo "Please select a supported encoder"
		usage
		exit 1
	fi	

	echo -e "\n\e[32mGENERATING MP4 COMPLETE\e[0m\n"
}


generate_dash (){


	print_line
	echo -e "###################     STEP 3 - SEGMENT AND CREATE MPD         ###################"
	print_line

	encoding=$ENCODING

	segmentlist=(`echo $SEGMENTSIZE | tr ',' ' '`)

	NUMBEROFTESTSEG=${#segmentlist[@]}
	
	cd $VIDDIR
	mpd="video_${encoding}_dash.mpd"

	for ((i=0;i<$NUMBEROFTESTSEG;i++));
	do
		segmenttime=${segmentlist[i]}

		tmpdir="$VIDDIR/$encoding/seg_${segmentlist[i]}"
		mkdir -p $tmpdir
		cd $tmpdir

		## Check if there's extra commands for MP4Box command
		if [[ -z $MP4REMAININGCMD ]];
		then
			MP4Box -dash ${segmenttime} -segment-name segment_ $VIDDIR/$encoding/video_${encoding}.mp4 &> ./MP4Box_${segmenttime}.output
		else
			MP4Box -dash ${segmenttime} -segment-name segment_ $MP4REMAININGCMD $VIDDIR/$encoding/video_${encoding}.mp4 &> ./MP4Box_${segmenttime}.output
		fi

		cp $CONFIGDIR/myapp.js $CONFIGDIR/runtest.html $VIDDIR/$encoding/seg_${segmenttime}/
		cd $VIDDIR/$encoding/seg_${segmenttime}/
		# Edit files
		sed -i "s|MPDGOESHERE|$mpd|g" myapp.js

		cat <<-EOF

			Creating $segmenttime ms segments and dash files
			MPD and Segments are here: $tmpdir
			See output from MP4box here $tmpdir/MP4Box_${segmenttime}.output
			myapp.js & runtest.html here $VIDDIR/$encoding/seg_${segmenttime}/

		EOF
	done

	echo -e "\e[32mSEGMENT AND CREATE MPD COMPLETE\e[0m\n"
}

generate_shaka (){

	print_line
	echo -e "################### STEP 4 - RUN TESTS ONE AT A TIME		###################"
	print_line


	## Need to move files in place
	segmentlist=(`echo $SEGMENTSIZE | tr ',' ' '`)
	encoding=$ENCODING

        NUMBEROFTESTSEG=${#segmentlist[@]}
       
       	shakadist="${SHAKADIR}/dist"
	cd $PUBLICHTML
	test -L dist || sudo ln -s $shakadist dist

	for ((i=0;i<$NUMBEROFTESTSEG;i++));
        do
		segment=${segmentlist[i]}
		echo -e "\nMoving files for ${segment} ms segment test into $PUBLICHTML"
		
		## copy the files into place
		rm -f $PUBLICHTML/segment_* > /dev/null
		test -e $PUBLICHTML/runtest.html && rm -f $PUBLICHTML/runtest.html
		test -e $PUBLICHTML/myapp.js && rm -f $PUBLICHTML/myapp.js
		
		cd $VIDDIR/$encoding/seg_${segment}/
		sudo cp segment_* runtest.html myapp.js $mpd $PUBLICHTML  

		echo -e "Files are now in place for ${segment} test.\nPlease connect to http://<YOUR IP>/runtest.html\nOnce ready you can then move onto further tests.....\n"
	
		if [[ $NUMBEROFTESTSEG -ne 1 ]];
		then

			let next=i+1

			if [[ $next -lt $NUMBEROFTESTSEG ]];
			then
				read -p "`echo -e "\nWould you like to continue with ${segmentlist[next]} ms test?\nType y to continue or any other key to exit:\n"`" -n 1 -r response

				rep=`echo $response | tr '[:upper:]' '[:lower:]'`
		
				if [[ $rep != "y" ]];then
					echo -e "\nexiting..."
					exit 0
				fi
				echo ""
			fi
		fi	
        done

	echo -e "\e[32mRUN TESTS ONE AT A TIME COMPLETE\e[0m\n"
}

SKIP=false
IGNORE=false

while getopts "f:him:v:" key;
do
	case $key in
		f)
			FFMPEGFLAGS=$OPTARG
			;;	
		h)
			usage
			exit 0
			;;
		i)
			IGNORE=true
			;;
		m)
			MP4BOXFLAGS=$OPTARG
			;;
		v)
			YUVVID=$OPTARG
			if [ -z $YUVVID ];then
                                echo "-v is Mandatory! Exiting...."
                                usage
                                exit 1
                        fi
                        ;;

	esac
done

if ! $IGNORE; then
	pre_checks
else 
	cat <<-EOF
		##################################################################################
		###################	STEP 1 - SKIPPING PRECHECKS		################## 
		##################################################################################

		-i flag supplied in the command line. Skipping pre checks

	EOF

fi

ENCODING="`echo $FFMPEGFLAGS | perl -nle 'm/-c\:v ([A-za-z\-0-9]*)/; print $1' | grep -i [a-z]`"
SEGMENTSIZE="`echo $MP4BOXFLAGS | perl -nle 'm/-dash ([0-9\,]*)/; print $1'`"

if [ -z $SEGMENTSIZE ];then
        
	## No point going on if no segment times passed in.
	echo -e "\nNo segment times provided! Please see Usage below. \e[31mExiting....\e[0m\n"
        usage
        exit 1
fi

DASHSIZE="`echo $MP4BOXFLAGS | perl -nle 'm/(-dash [0-9\,]*)/; print $1'`"
MP4REMAININGCMD="`echo $MP4BOXFLAGS | sed "s/${DASHSIZE}//"`" 

generate_mp4 
generate_dash 
generate_shaka
