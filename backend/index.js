// Import required dependencies
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import pkg from 'pg';
import { clerkMiddleware } from '@clerk/express';

const { Pool } = pkg;
const app = express();

// Use Clerk middleware for authentication
app.use(clerkMiddleware({
  secretKey: process.env.CLERK_SECRET_KEY
}));

// Middleware for logging requests
const requestLogger = (req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  console.log('Headers:', req.headers);
  next();
};

app.use(requestLogger);

// CORS setup with security configurations
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json());

// Initialize PostgreSQL connection pool with error handling
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Function to initialize database schema
async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        description TEXT NOT NULL,
        amount INTEGER NOT NULL,
        category TEXT NOT NULL,
        date TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, description, amount, category, date)
      );

      CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
    `);
    
    console.log('Database schema initialized successfully');
  } catch (err) {
    console.error('Error initializing database schema:', err);
    process.exit(1);
  }
}

// Initialize database on startup
initializeDatabase();

// Test database connection
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('Database connection error:', err);
    process.exit(1);
  } else {
    console.log('Database connected successfully at:', res.rows[0].now);
  }
});

// Middleware to verify authentication
const requireAuth = (req, res, next) => {
  if (!req.auth?.userId) {
    return res.status(401).json({ 
      error: 'Unauthorized',
      message: 'Authentication required for this operation'
    });
  }
  next();
};

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Budget Categories Routes

// Get all budget categories (protected route)
app.get('/budget-categories', requireAuth, async (req, res, next) => {
  try {
    const userId = req.auth.userId;
    console.log('Fetching budget categories for user:', userId);
    const result = await pool.query(
      'SELECT * FROM budget_categories WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// Add a new budget category (protected route)
app.post('/budget-categories', requireAuth, async (req, res, next) => {
  try {
    const { name, amount } = req.body;
    const userId = req.auth.userId;

    if (!name || amount === undefined) {
      return res.status(400).json({ error: 'Missing required fields', required: ['name', 'amount'] });
    }

    const result = await pool.query(
      'INSERT INTO budget_categories (user_id, name, amount) VALUES ($1, $2, $3) RETURNING *',
      [userId, name, amount]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {  // Unique violation
      return res.status(409).json({
        error: 'Duplicate category',
        message: 'A category with this name already exists for the user.',
      });
    }
    next(err);
  }
});

// Update a budget category (protected route)
app.put('/budget-categories/:id', requireAuth, async (req, res, next) => {
  try {
    const { name, amount } = req.body;
    const userId = req.auth.userId;
    const categoryId = req.params.id;

    if (!name || amount === undefined) {
      return res.status(400).json({ error: 'Missing required fields', required: ['name', 'amount'] });
    }

    const result = await pool.query(
      'UPDATE budget_categories SET name = $1, amount = $2 WHERE id = $3 AND user_id = $4 RETURNING *',
      [name, amount, categoryId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Not found', message: 'Category not found or not authorized to update' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// Delete a budget category (protected route)
app.delete('/budget-categories/:id', requireAuth, async (req, res, next) => {
  try {
    const userId = req.auth.userId;
    const categoryId = req.params.id;

    const result = await pool.query(
      'DELETE FROM budget_categories WHERE id = $1 AND user_id = $2 RETURNING *',
      [categoryId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Not found', message: 'Category not found or not authorized to delete' });
    }

    res.json({ message: 'Category deleted successfully', id: categoryId });
  } catch (err) {
    next(err);
  }
});

// Transactions Routes

// Get all transactions (protected route)
app.get('/transactions', requireAuth, async (req, res, next) => {
  try {
    console.log('Fetching transactions for user:', req.auth.userId);

    const { startDate, endDate, category } = req.query;
    let queryText = 'SELECT * FROM transactions WHERE user_id = $1';
    const queryParams = [req.auth.userId];

    if (startDate && endDate) {
      queryText += ' AND date BETWEEN $2 AND $3';
      queryParams.push(startDate, endDate);
    }

    if (category) {
      queryText += ` AND category = $${queryParams.length + 1}`;
      queryParams.push(category);
    }

    queryText += ' ORDER BY date DESC, created_at DESC';

    const result = await pool.query(queryText, queryParams);

    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// Add new transaction (protected route)
app.post('/transactions', requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  
  try {
    const { description, amount, category, date } = req.body;
    const userId = req.auth.userId;

    if (!description || amount === undefined || !category || !date) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        required: ['description', 'amount', 'category', 'date']
      });
    }

    if (typeof amount !== 'number' || isNaN(amount)) {
      return res.status(400).json({
        error: 'Invalid amount',
        message: 'Amount must be a valid number'
      });
    }

    const transactionDate = new Date(date);
    if (isNaN(transactionDate.getTime())) {
      return res.status(400).json({
        error: 'Invalid date format',
        message: 'Please provide a valid date'
      });
    }

    await client.query('BEGIN');

    const existingTransaction = await client.query(
      `SELECT id FROM transactions 
       WHERE user_id = $1 
       AND description = $2 
       AND amount = $3 
       AND category = $4 
       AND date = $5
       AND created_at > NOW() - INTERVAL '1 minute'`,
      [userId, description, amount, category, transactionDate]
    );

    if (existingTransaction.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Duplicate transaction',
        message: 'A similar transaction was submitted in the last minute. Please wait or modify the details.',
        duplicateId: existingTransaction.rows[0].id
      });
    }

    const result = await client.query(
      `INSERT INTO transactions 
        (user_id, description, amount, category, date) 
       VALUES ($1, $2, $3, $4, $5) 
       RETURNING *`,
      [userId, description, amount, category, transactionDate]
    );

    await client.query('COMMIT');
    
    res.status(201).json(result.rows[0]);

  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// Update transaction (protected route)
app.put('/transactions/:id', requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  
  try {
    const { description, amount, category, date } = req.body;
    const userId = req.auth.userId;
    const transactionId = req.params.id;

    if (!description || amount === undefined || !category || !date) {
      return res.status(400).json({ error: 'Missing required fields', required: ['description', 'amount', 'category', 'date'] });
    }

    const transactionDate = new Date(date);
    if (isNaN(transactionDate.getTime())) {
      return res.status(400).json({ error: 'Invalid date format' });
    }

    await client.query('BEGIN');

    const existingTransaction = await client.query(
      'SELECT id FROM transactions WHERE id = $1 AND user_id = $2',
      [transactionId, userId]
    );

    if (existingTransaction.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        error: 'Not found',
        message: 'Transaction not found or not authorized to update'
      });
    }

    const result = await client.query(
      `UPDATE transactions 
       SET description = $1, amount = $2, category = $3, date = $4
       WHERE id = $5 AND user_id = $6
       RETURNING *`,
      [description, amount, category, transactionDate, transactionId, userId]
    );

    await client.query('COMMIT');

    res.json(result.rows[0]);

  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// Delete transaction (protected route)
app.delete('/transactions/:id', requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  
  try {
    const transactionId = parseInt(req.params.id);
    const userId = req.auth.userId;

    const result = await client.query(
      'DELETE FROM transactions WHERE id = $1 AND user_id = $2 RETURNING *',
      [transactionId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Not found',
        message: 'Transaction not found or not authorized to delete'
      });
    }

    res.json({
      message: 'Transaction deleted successfully',
      id: transactionId
    });

  } catch (err) {
    next(err);
  } finally {
    client.release();
  }
});

// Error handler middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  
  if (err.code === '23505') {
    return res.status(409).json({
      error: 'Conflict',
      message: 'This transaction already exists'
    });
  }
  
  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'production' 
      ? 'An unexpected error occurred' 
      : err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
  });
});

// Graceful shutdown handler
process.on('SIGTERM', async () => {
  console.log('SIGTERM signal received: closing HTTP server');
  await pool.end();
  process.exit(0);
});

// Start the server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

export default app;
