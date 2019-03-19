#!/bin/bash

RESFILE=$1
TMPFILE="./results/tmp"

prev=0
let filenumber=$prev+1
TESTFILE="./results/test_${filenumber}.csv"

grep -B3 "segment_[0-9]" ./results/$RESFILE | grep -e "time" -e "url" | sed 's/^[ \t]*"/"/' | xargs -n2 -d '\n' > $TMPFILE

rm -f ./results/test_*
while read line;
do

	TIME="`echo $line | cut -d ',' -f1 | cut -d ':' -f2 | sed 's/^ //'`"
	SEG="`echo $line | awk -F/ '{print $NF}' | cut -d '"' -f1`"

	curr=`echo $SEG | tr '.' '_' | cut -d '_' -f2`
	
	if [[ curr -lt prev ]];
	then
		((filenumber+=1))
		TESTFILE="./results/test_${filenumber}.csv"
	fi	
	echo $SEG,$TIME >> $TESTFILE
	prev=$curr

done < $TMPFILE

## Cleanup
rm $TMPFILE

for file in ./results/test*; do
	echo "Total Download time for all segments in $file: `cat $file | awk -F',' '{sum+=$2;} END{print sum;}'`"
done
