'use strict';
const path = require('path');
const fs = require('fs');
const { openDb } = require('./db');
const { createApp } = require('./app');
const { seedIfEmpty } = require('./seed');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = openDb(path.join(DATA_DIR, 'barista.db'));
seedIfEmpty(db);

const port = Number(process.env.PORT || 3000);
const app = createApp(db);
app.listen(port, () => {
  console.log(`咖啡师履历与课程站已启动: http://localhost:${port}`);
  console.log(`管理端: http://localhost:${port}/admin`);
});
