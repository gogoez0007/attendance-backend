require('dotenv').config();
const mysql = require('mysql2/promise'); // Use the promise-based version of mysql2

// Create a pool or single connection
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
});

module.exports = db;
