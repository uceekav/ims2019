#!/bin/bash

while getopts "r:" key;
do
        case $key in
                r)
                        RESFILE=$OPTARG
                        if [ ! -f $RESFILE ];then
                                echo "File does not exist"
                                exit 1
                        fi
                        ;;
        esac
done

if [[ -z $RESFILE ]];
then
	echo "File not supplied"
	exit 1
fi

TMPFILE="./results/tmp"

prev=0
let filenumber=$prev+1

DIR="`echo $RESFILE | cut -d '.' -f1`"
PUTDIR="$DIR/"
#echo "$PUTDIR"
mkdir -p $PUTDIR

TESTFILE="$PUTDIR/test_${filenumber}.csv"

## clear out - hmmh risky......
rm -f $PUTDIR/*

## Grep for the segment name and 3 lines above it. Then get grep the time and segment name. Reformat with sed and print on one line
grep -B3 "segment_[0-9]" $RESFILE | grep -e "time" -e "url" | sed 's/^[ \t]*"/"/' | xargs -n2 -d '\n' > $TMPFILE


#The har files has all the tests. In this while loop each test is split into an individual file. 
while read line;
do

	TIME="`echo $line | cut -d ',' -f1 | cut -d ':' -f2 | sed 's/^ //'`"
	SEG="`echo $line | awk -F/ '{print $NF}' | cut -d '"' -f1`"

	curr=`echo $SEG | tr '.' '_' | cut -d '_' -f2`
	
	if [[ curr -lt prev ]];
	then
		((filenumber+=1))
		TESTFILE="$PUTDIR/test_${filenumber}.csv"
	fi	
	echo $SEG,$TIME >> $TESTFILE
	prev=$curr

done < $TMPFILE

## Cleanup
rm $TMPFILE

## For each individual test file print out the latency 
for file in ./$PUTDIR/test*; do
	echo "Total Download time for all segments in $file: `cat $file | awk -F',' '{sum+=$2;} END{print sum;}'`"
done
