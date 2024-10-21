// backend/index.js
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

// Create a new transaction
app.post('/transactions', async (req, res) => {
  const { description, amount, category, date } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO transactions (description, amount, category, date) VALUES ($1, $2, $3, $4) RETURNING *',
      [description, amount, category, date]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Get all transactions
app.get('/transactions', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM transactions');
    res.json(result.rows);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Get a specific transaction by ID
app.get('/transactions/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('SELECT * FROM transactions WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).send('Transaction not found');
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Update a transaction
app.put('/transactions/:id', async (req, res) => {
  const { id } = req.params;
  const { description, amount, category, date } = req.body;
  try {
    const result = await pool.query(
      'UPDATE transactions SET description = $1, amount = $2, category = $3, date = $4 WHERE id = $5 RETURNING *',
      [description, amount, category, date, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).send('Transaction not found');
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Delete a transaction
app.delete('/transactions/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM transactions WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      return res.status(404).send('Transaction not found');
    }
    res.json({ message: 'Transaction deleted' });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
