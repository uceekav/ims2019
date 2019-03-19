#!/bin/bash

## Config File
source `pwd`/config/config.cfg



usage(){

cat << EOF
#########################################################################################
#											#
# usage: runcode.sh [-fhisv]								#	
# -f FFMPEG flags e.g. -f "-c:v libvpx-vp9 -t 5"					#
# -h This help message.									#
# -i Ignores Pre checks									#
# -s Segment times in ms, e.g. -s 1000,2000,3000  					#
# -v Raw video file to encode								#
#											#
# Example:										#
# This Command says encode the first 5 seconds of akiyo_qcif.y4m with libvpx-vp9.	#
# Create two tests:									# 
#	1. Segments are 1000 ms								#	
#	2. Segments are 2000 ms 							#
#											#
# sudo ./runcode.sh -f "-c:v libvpx-vp9 -t 5" -i -s 1000,2000 -v static/akiyo_qcif.y4m	# 
#											#
#########################################################################################
EOF

}

pre_checks (){


	echo -e "\n###################     STEP 1 - PRECHECKS                      ###################\n"
	## check ffmpeg
	which ffmpeg
	
	if [[ $? -eq 0 ]]; then
	
		## Use which ffmpeg install
		FFMPEG=`which ffmpeg`
		echo "FFMPEG PATH is: ${FFMPEG}"
	else
		echo "FFMPEG PATH is: ${FFMPEG}"
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

	echo -e "\e[32mPRECHECKS COMPLETE\e[0m\n"

}

parse_encoding (){

	##TODO BUT IN A BETTER CHECK
	echo -e "\n###################     STEP 2 - PARSE ENCODING                 ##################\n"

	if [[ $FFMPEGFLAGS =~ .*libx264.* ]];
	then
		ENCODING=libx264
	elif [[ $FFMPEGFLAGS =~ .*libx265.* ]];
	then
		ENCODING=libx265
	elif [[ $FFMPEGFLAGS =~ .*libvpx-vp9.* ]]
	then
		ENCODING=libvpx-vp9
	else
		echo "Unable to get encoding from -f flag."
		usage
		exit 1
	fi
	echo "Encoding Set to $ENCODING"
	echo -e "\e[32mPARSE ENCODING COMPLETE\e[0m\n"
}

generate_mp4 (){

	echo -e "\n###################     STEP 3 - GENERATING MP4                 ##################\n"

	encoding=$ENCODING

	if [[ -z $YUVVID ]];
	then
		echo "-v is Mandatory! Exiting...."
		usage
		exit 1
	fi

	video="`pwd`/$YUVVID"

	if [[ ! -f $video ]];then
		echo "$video does not exist"
		usage
		exit 1
	fi
	## cleanup from previous runs
	cd $VIDDIR
	rm -rf ./$encoding/* > /dev/null

	vp9="libvpx-vp9"
	x264="libx264"


	if [[ ( "$encoding" == "$vp9" || "$encoding" == "$x264" ) ]];
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

	echo -e "\e[32mGENERATING MP4 COMPLETE\e[0m\n"
}


generate_dash (){


	echo -e "###################     STEP 4 - SEGMENT AND CREATE MPD         ##################\n"

	encoding=$ENCODING
	if [ -z $SEGMENTSIZE ];then
        	echo -e "No segment times provided! Please see Usage below. \e[31mExiting....\e[0m"
		usage
		exit 1
	fi

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

		MP4Box -dash ${segmenttime} -segment-name segment_ $VIDDIR/$encoding/video_${encoding}.mp4 &> ./MP4Box_${segmenttime}.output
       		
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

	echo -e "################### STEP 5 - RUN TESTS ONE AT A TIME ###################\n"

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
		echo "Moving files for ${segment} ms segment test into $PUBLICHTML"
		
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
			fi
		fi	
        done

	echo -e "\e[32mRUN TESTS ONE AT A TIME COMPLETE\e[0m\n"
}

IGNORE=false

while getopts "f:his:v:" key;
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
		s)
			SEGMENTSIZE=$OPTARG
			if [ -z $SEGMENTSIZE ];then
                		echo "-s is Mandatory! Exiting...."
				usage
                		exit 1
			fi
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
		#############  STEP 1 - SKIPPING PRECHECKS ###################

		-i flag supplied in the command line. Skipping pre checks

	EOF

fi

parse_encoding
generate_mp4 
generate_dash 
generate_shaka

