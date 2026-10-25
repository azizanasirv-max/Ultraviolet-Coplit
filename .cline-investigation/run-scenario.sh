#!/bin/bash
cd /workspace
nohup timeout 240 .cline-investigation/run.sh "$1" "$2" > .cline-investigation/logs/"$1$2".log 2>&1 &
echo $!
