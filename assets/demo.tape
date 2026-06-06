# VHS tape for the SkillCI demo GIF.  Regenerate with:  vhs assets/demo.tape
Output assets/demo.gif

Set Shell "bash"
Set FontSize 16
Set Width 1180
Set Height 820
Set Padding 26
Set Theme "Catppuccin Latte"
Set TypingSpeed 40ms

# Hidden setup: cd + alias so the visible commands read `skillci`.
Hide
Type "cd ~/Documents/code/skillCI" Enter
Type 'alias skillci="node dist/cli/index.js"' Enter
Type "clear" Enter
Show

Sleep 500ms
Type "# 1. The bundled sample tasks SkillCI evaluates against" Enter
Sleep 400ms
Type "skillci tasks" Enter
Sleep 2.5s

Type "# 2. Run baseline-vs-candidate (offline demo, deterministic, no API key)" Enter
Sleep 400ms
Type "skillci run --demo" Enter
Sleep 4.5s
Type "# -> VERDICT: IMPROVED  ·  the regression gate decides if a PR opens" Enter
Sleep 2.5s
