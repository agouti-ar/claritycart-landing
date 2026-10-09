require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
// Enable CORS for frontend requests
app.use(cors({
    origin: '*' // In production, this should be restricted to your domain
}));
// Parse JSON request bodies
app.use(express.json());

// Initialize Supabase with the SERVICE_ROLE key to bypass RLS restrictions securely on the server
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// --- API ENDPOINTS ---

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'ClarityCart API is running!' });
});

// Domain validation endpoint
app.post('/api/validate-domain', async (req, res) => {
    const { domain } = req.body;
    
    if (!domain) {
        return res.status(400).json({ valid: false, error: 'Domain is required' });
    }

    // Basic syntax check for a domain
    const domainPattern = /^[a-zA-Z0-9][a-zA-Z0-9-]{1,61}[a-zA-Z0-9]\.[a-zA-Z]{2,}$/;
    if (!domainPattern.test(domain)) {
        return res.status(400).json({ valid: false, error: 'Invalid domain format (e.g. mystore.com)' });
    }

    // Here we can add real DNS validation or API calls to Shopify/WooCommerce later.
    // For now, we simulate a successful validation.
    console.log(`[Backend] Validating domain: ${domain}... OK!`);
    
    res.json({ valid: true, message: 'Domain is valid' });
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
