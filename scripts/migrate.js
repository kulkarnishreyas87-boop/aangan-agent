import { readFile } from 'node:fs/promises';
import { db } from '../src/db.js';

const sql = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
await db().query(sql);
console.log('Schema applied to Neon.');
await db().end();
