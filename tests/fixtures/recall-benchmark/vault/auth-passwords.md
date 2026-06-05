# Password hashing

Use argon2id with per-user salts for password hashing. Never store plaintext;
migrate legacy bcrypt hashes on the next successful login.
