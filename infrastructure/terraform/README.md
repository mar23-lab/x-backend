# Terraform Infrastructure Authority

This directory owns the tracked Terraform source formerly held in
`xlooop-platform-starter` at commit `1a35af7`.

Only declarative source and provider lock files belong here. State, plans,
credentials, backend values and populated variable files are forbidden. The
remote state backend remains an external operational dependency and is never
copied into Git.
