# Builds the claude.ai preview page (the viewer supplies <html>/<head>/<body>) from app/index.html.
import sys
out = sys.argv[1]
s = open('app/index.html').read()
body = s[s.index('<!--APP-->') + 10:s.index('<!--/APP-->')]
head = '''<title>Thendral Text-to-Speech</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="style.css">
'''
open(out, 'w').write(head + body)
