#!/bin/bash

## Config File
source `pwd`/config/config.cfg

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

IGNORE=false

while getopts ":hi" key;
do
	case $key in 
		h)
			cat <<-EOF
			usage: runcode.sh [-iah]	
				-i Ignores Pre checks
				-a Changes Apache config
				-h This help message.
			EOF
			exit 0
			;;
		i)
			IGNORE=true
			;;
	esac
done

echo $IGNORE

if ! $IGNORE; then
	echo "Running prechecks..."
	pre_checks
fi
#if [ "${1}" == "-c" ] || [ "${1}" == "--checks" ]; then 
#	echo "Running prechecks..."
#	pre_checks
#elif [ "${1}" != "" || [ "${1}" == "-h" ] || [ "${1}" == "--help" ];then
#	cat <<-EOF
#	Usage: 
#	Run pre checks -c or --checks
#	Move apache config into place -a or --apache
#	EOF
#else	
#	echo "Skipping prechecks..."
#fi
