# Holostaff CLI demo — the real /scan flow, recorded live.
#
# Re-render (from a repo you want to scan, signed in):
#   vhs /path/to/holostaff-cli/assets/demo.tape
#
# The two Hide blocks cut the scan's work time (a few minutes each);
# everything shown is a genuine, unedited session.
Output assets/demo.gif

Set Shell "bash"
Set FontSize 14
Set Width 1000
Set Height 600
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
Wait+Screen@25m /Send this to your Holostaff workspace/
Show
Sleep 4s

Type "y"
Wait+Screen@3m /View at https/
Sleep 5s
