import { existsSync } from 'fs'
// Node ≥ 20.12 can read .env natively; real environment variables always win over the file.
if (existsSync('.env')) process.loadEnvFile('.env')
