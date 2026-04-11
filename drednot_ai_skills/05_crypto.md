# Encryption System
Uses PBKDF2 → AES-GCM

Functions:
- cryptoDeriveKeys(password, groupCode)
- cryptoEncryptPos(encKey, data)
- cryptoDecryptPos(encKey, data)

RULES:
- NEVER modify logic
- NEVER send raw passwords
- Must stay compatible
