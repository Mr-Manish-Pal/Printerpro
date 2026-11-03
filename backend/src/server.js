const express = require('express');
const cors = require('cors');
const path = require('path');
const config = require('./config/env');
const db = require('./config/db');
const apiRoutes = require('./routes/api');
const errorHandler = require('./middleware/errorHandler');

const app = express();

// Enable Cross-Origin Resource Sharing
app.use(cors());

// Parse JSON and URL-encoded request bodies
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend assets (Mobile Kiosk UI)
const frontendPath = path.resolve(__dirname, '../../frontend/public');
app.use(express.static(frontendPath));

// API Routes
app.use('/api', apiRoutes);

// Centralized Error Handling Middleware
app.use(errorHandler);

// Start HTTP Server when executed directly
let server = null;
if (require.main === module) {
  server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`=======================================================`);
    console.log(`  Auto Print Kiosk Backend Server Running!`);
    console.log(`  Port: http://localhost:${config.port}`);
    console.log(`  LAN / WiFi access: http://<your-pc-ip>:${config.port}`);
    console.log(`  Environment: ${config.nodeEnv}`);
    console.log(`=======================================================`);
  });

  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
}

// Graceful Shutdown
function handleShutdown(signal) {
  console.log(`\nReceived ${signal}. Gracefully closing server and database...`);
  if (server) {
    server.close(() => {
      try {
        db.close();
        console.log('Database connection closed.');
      } catch (err) {
        console.error('Error closing database:', err.message);
      }
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
}

module.exports = { app, server };
