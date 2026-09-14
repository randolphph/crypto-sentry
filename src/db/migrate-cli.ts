import { loadConfig } from '../config.js';
import { createDatabase } from './client.js';

const config = loadConfig();
const database = createDatabase(config.databasePath);
database.close();
process.stdout.write('Database migrations completed successfully.\n');
