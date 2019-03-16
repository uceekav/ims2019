## For information on VMAF: https://github.com/Netflix/vmaf


## To encode to x264 bitstream:
./ffmpeg -i box.mp4 -c:v libx264 -b 32k box_32_h264.mp4

## To encode to x265 bitstream:
./ffmpeg -i box.mp4 -c:v libx265 -b 32k box_32_hevc.mp4

## To encode to VP9 bitstream:
./ffmpeg -i box.mp4 -c:v libvpx-vp9 -b 32k box_32_vp9.webm

## To measure VMAF:
./ffmpeg -i box_32_h264.mp4 -i box.mp4 -lavfi libvmaf="model_path=./model/vmaf_v0.6.1.pkl:psnr=1:log_fmt=json" -f null -

