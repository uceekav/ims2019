#!/bin/bash

## Config File
source `pwd`/config/config.cfg



usage(){

cat << EOF
#########################################################
#							#
# usage: runcode.sh [-iah]				#
# -e encoder to use,e.g -e libx264 or -e libvpx-vp9	#							#
# -i Ignores Pre checks					#
# -a Changes Apache config				#
# -h This help message.					#
# -s Segment times in ms, e.g. -s 1000,2000,3000  	#
#							#
#########################################################
EOF

}


pre_checks (){

	## check ffmpeg
	which ffmpeg
	
	if [[ $? -eq 0 ]]; then
	
		## Use which ffmpeg install
		FFMPEG=`which ffmpeg`
		echo "using ffmpeg from which command"
		echo "PATH is: ${FFMPEG}"
	else
		echo "using local ffmpeg"
		echo "FFMPEG PATH is: ${FFMPEG}"
	fi

	## Shaka Dir
	echo "Shaka dir: $SHAKADIR"

	which MP4Box

	if [[ $? -ne 0 ]]; then
	
		echo "Please install MP4box"
		exit 1
	fi


	## Check apache is installed
	which apache2

	if [[ $? -eq 0 ]]; then

        	## Use which ffmpeg install
        	APACHE2=`which apache2`
        	echo "APACHE PATH is: ${APACHE2}"

		## check if apache running 
		ps -ef | grep -i apache2 | grep -qv "grep"

		if [ $? -eq 0 ]; then
			echo "apache is running. Hope the config is right!"
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

	#/usr/sbin/apache2
	# Check that something is listening on 443 or 80
	#netstat -anp | grep -e ":180" -e ":443"

}

generate_mp4 (){

	encoding=$1

	## cleanup fro previous run
	cd $VIDDIR
	rm -rf ./$encoding/*

	vp9="libvpx-vp9"
	x264="libx264"

	echo $encoding
	
	if [[ ( "$encoding" == "$vp9" || "$encoding" == "$x264" ) ]];
	then
		echo $encoding $YUVVID
		mkdir -p $encoding
		$FFMPEG -i $YUVVID -c:v $encoding -b 32k $encoding/box_32_${encoding}.mp4 &> $encoding/ffmpeg_${encoding}.output
	else
		echo "Please select a supported encoder"
		usage
		exit 1
	fi	

}


generate_dash (){

	echo $1
	echo $2
	if [ -z $SEGMENTSIZE ];then
        	echo "No segment times provided! Please see Usage below. Exiting...."
		usage
		exit 1
	fi

	segmentlist=(`echo $1 | tr ',' ' '`)
	echo "${#segmentlist[@]} Segments size. Creating videosì...."

	echo ${segmentlist[0]} ${segmentlist[1]} ${#segmentlist[@]}

	NUMBEROFTESTSEG=${#segmentlist[@]}
	
	cd $VIDDIR

	for ((i=0;i<$NUMBEROFTESTSEG;i++));
	do
		segmenttime=${segmentlist[i]}
		tmpdir="$VIDDIR/$2/seg_${segmentlist[i]}"
                echo $tmpdir
		echo "Generating files for $segmenttime ms"
		echo "Creating directory ${tmpdir}"
		mkdir -p $tmpdir
		cd $tmpdir

		#clean up form previous runs
		echo "Creating segments and dash files. See output from MP4box here $tmpdir/MP4Box_${segmenttime}.output"
		MP4Box -dash ${segmenttime} -rap -segment-name segment_ $VIDDIR/$2/box_32_${2}.mp4 &> ./MP4Box_${segmenttime}.output
	done

	## Generate MP4
	#$FFMPEG -i box.mp4 -c:v libx264 -b 32k box_32_h264.mp4

	## Create dash and segment
	#MP4Box -dash 4000 -rap -segment-name segment_ box_32_h264.mp4

}

generate_shaka (){

	## Need to move files in place
	segmentlist=(`echo $1 | tr ',' ' '`)
	encoding=$2

	echo $PUBLICHTML
	
	#dir=$


        NUMBEROFTESTSEG=${#segmentlist[@]}
	echo $NUMBEROFTESTSEG
       
       	shakadist="${SHAKADIR}/dist"
	cd $PUBLICHTML
	test -L dist || sudo ln -s $shakadist dist
	cd -

	mpd="box_32_${encoding}_dash.mpd"

	for ((i=0;i<$NUMBEROFTESTSEG;i++));
        do
		segment=${segmentlist[i]}
		cd $VIDDIR/
       		cp myapp.js runtest.html $VIDDIR/$encoding/seg_${segment}/
		cd $VIDDIR/$encoding/seg_${segment}/
		## Edit files
		sed -i "s|MPDGOESHERE|$mpd|g" myapp.js

		## move the files into place
		sudo cp segment_* runtest.html myapp.js $mpd $PUBLICHTML  

		read -p "`echo -e "Files are now in place for ${segment} test.\nPlease connect to http://<YOUR IP>/runtest.html\nWhen ready to run move onto next test type y otherwise any other key to exit:\n"`" -n 1 -r response

		echo ""
		rep=`echo $response | tr '[:upper:]' '[:lower:]'`
		if [[ $rep != "y" ]];then
			echo "exiting..."
			exit 0
		fi	
        done
}







IGNORE=false

while getopts "his:e:" key;
do
	case $key in
	        e)
			ENCODING=$OPTARG
			echo $ENCODING
			;;	
		h)
			usage
			exit 0
			;;
		i)
			pre_checks
			;;
		s)
			SEGMENTSIZE=$OPTARG
			echo $SEGMENTSIZE
			if [ -z $SEGMENTSIZE ];then
                		"No segment times provided! Exiting...."
				usage
                		exit 1
			fi

			;;
	esac
done

if ! $IGNORE; then
	echo "Running prechecks..."
	pre_checks
fi
#generate_mp4 $ENCODING
#generate_dash $SEGMENTSIZE $ENCODING
generate_shaka $SEGMENTSIZE $ENCODING

