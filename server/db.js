'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const schema = require('./schema');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');   // 并发预订时保证事务原子性
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.exec(schema);

module.exports = db;
