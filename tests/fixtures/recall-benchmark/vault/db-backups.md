# Nightly backup strategy

A cron job snapshots the SQLite database every night, verifies integrity with
a checksum, and rotates the last fourteen backup archives offsite.
