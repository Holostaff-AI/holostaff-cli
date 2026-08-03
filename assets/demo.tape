# Holostaff CLI demo — the real /scan flow, recorded live.
#
# Re-render (from a repo you want to scan, signed in):
#   vhs /path/to/holostaff-cli/assets/demo.tape
#
# The two Hide blocks cut the scan's work time (a few minutes each);
# everything shown is a genuine, unedited session.
# The raw recording is post-processed (scripts in repo history / see README
# commit) into assets/demo.gif with one global palette and no dithering,
# preserving per-frame delays. vhs MP4 output compresses time (deduped
# frames at constant fps), so the GIF is the master.
Output demo.gif

Set Shell "bash"
Set FontSize 14
Set Width 1250
Set Height 1150
Set Padding 16
Set Theme "Catppuccin Mocha"
Set TypingSpeed 70ms

Type "holostaff"
Enter
Wait+Screen@30s /let's get going/
Sleep 2.5s

Type "/scan"
Sleep 500ms
Enter
Wait+Screen@60s /Scanning/
Sleep 4s

Hide
Wait+Screen@20m /map is live/
Show
Sleep 3.5s

Hide
Wait+Screen@25m /Yes, upload now/
Show
Sleep 4s

Type "y"
Wait+Screen@3m /View at/
Sleep 5s
