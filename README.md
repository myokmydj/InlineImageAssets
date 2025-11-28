Uploading more than 500 to 1,000 images may cause the node to crash.
**Depending on your system specifications, edit `node server.js %*` in the `start.bat` file to `node --max-old-space-size=16384 server.js %*`. 
You should also apply this same modification to `UpdateForkAndStart.bat` and `UpdateAndStart.bat` according to your specs.

Click the image button next to the description area in the character edit sidebar.
In the modal window, hit the upload button and upload as many images as you need.
If you click the copy button next to upload, it'll automatically generate the command for you.
Create a new entry in the character lorebook, paste the command there, and place it as low as possible in the priority list.
The bot will output it as `%%img:filename%%`, and the extension will convert that into an image.
