// ==========================================
// 1. DNS RESOLUTION WORKAROUND
// ==========================================
const dns = require('node:dns');
dns.setServers(['1.1.1.1', '1.0.0.1']); // Prevents Atlas querySrv ECONNREFUSED on local systems

// ==========================================
// 2. CONFIGURATIONS & IMPORTS
// ==========================================
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const Groq = require('groq-sdk');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const ChatSession = require('./models/ChatSession');

const app = express();
const PORT = process.env.PORT || 5000;

// Initialize the Groq SDK client
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ==========================================
// 3. ENVIRONMENT-AWARE MIDDLEWARE & SECURITY
// ==========================================
const isProduction = process.env.NODE_ENV === 'production';

if (isProduction) {
  // A. Strict Production Security
  app.use(helmet());
  
  // Reads the allowed domain from your Render dashboard settings; falls back to a default if missing
  const allowedOrigins = [process.env.ALLOWED_ORIGIN || 'https://your-app.vercel.app'];

  app.use(cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.indexOf(origin) === -1) {
        const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
        return callback(new Error(msg), false);
      }
      return callback(null, true);
    }
  }));

  // Rate Limiting to prevent server resource abuse
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    limit: 100, // Limit each IP to 100 requests per 15 minutes
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests from this IP, please try again later.' }
  });
  app.use('/api/chat/stream', limiter);
  app.use('/api/sessions', limiter);

} else {
  // B. Relaxed Local Development Security
  // Prevents Helmet from blocking API handshakes between port 5173 and 5000
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" }
  }));

  // Standard development CORS (Allows port 5173 and 127.0.0.1 to talk to port 5000)
  app.use(cors()); 
}

// Limits incoming JSON body size to prevent payload-flooding memory crashes
app.use(express.json({ limit: '10kb' }));

// ==========================================
// 4. DATABASE CONNECTION
// ==========================================
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('Connected to MongoDB Atlas Free Tier successfully.'))
  .catch((err) => {
    console.error('MongoDB connection failed:');
    console.error(err);
  });

// ==========================================
// 5. UTILITY FUNCTIONS
// ==========================================
function escapeRegex(string) {
  // Escapes regex characters (like $, +, ?, etc.) to prevent ReDoS injection attacks
  return string.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
}

// ==========================================
// 6. API ROUTES
// ==========================================

// Base verification check
app.get('/', (req, res) => {
  res.send('EchoChat Backend API is running.');
});

// Route A: Create a brand new, empty chat session
app.post('/api/sessions', async (req, res) => {
  try {
    const newSession = new ChatSession({
      title: 'New Chat',
      messages: []
    });
    const savedSession = await newSession.save();
    res.status(201).json(savedSession);
  } catch (error) {
    console.error('Failed to create session:', error);
    res.status(500).json({ error: 'Internal server error while creating session' });
  }
});

// Route B: Get a list of all sessions (for the sidebar)
app.get('/api/sessions', async (req, res) => {
  try {
    const sessions = await ChatSession.find()
      .select('title createdAt')
      .sort({ createdAt: -1 }); 
    res.json(sessions);
  } catch (error) {
    console.error('Failed to fetch sessions list:', error);
    res.status(500).json({ error: 'Internal server error while fetching sessions' });
  }
});

// Route C: Get details of a specific session (including message history)
app.get('/api/sessions/:id', async (req, res) => {
  try {
    const session = await ChatSession.findById(req.params.id);
    if (!session) {
      return res.status(404).json({ error: 'Chat session not found' });
    }
    res.json(session);
  } catch (error) {
    console.error('Failed to fetch session details:', error);
    res.status(500).json({ error: 'Internal server error while fetching session details' });
  }
});

// Route D: Delete a chat session
app.delete('/api/sessions/:id', async (req, res) => {
  try {
    const deletedSession = await ChatSession.findByIdAndDelete(req.params.id);
    if (!deletedSession) {
      return res.status(404).json({ error: 'Chat session not found' });
    }
    res.json({ message: 'Session deleted successfully' });
  } catch (error) {
    console.error('Failed to delete session:', error);
    res.status(500).json({ error: 'Internal server error while deleting session' });
  }
});

// Route E: Keyword Search Route (Protected against ReDoS attacks)
app.get('/api/search', async (req, res) => {
  const { q } = req.query;

  if (!q || q.trim() === '') {
    return res.status(400).json({ error: 'Query parameter "q" is required' });
  }

  try {
    const escapedQuery = escapeRegex(q); // Escape raw input safely
    
    const results = await ChatSession.find({
      'messages.content': { $regex: escapedQuery, $options: 'i' }
    }).select('title messages createdAt');

    res.json(results);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Search execution failed' });
  }
});

// Route F: Chat & Stream Response with History (Groq Integration)
app.post('/api/chat/stream', async (req, res) => {
  const { sessionId, message } = req.body;

  if (!sessionId || !message) {
    return res.status(400).json({ error: 'Session ID and user message are required' });
  }

  try {
    // 1. Fetch current session from database
    const session = await ChatSession.findById(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Chat session not found' });
    }

    // 2. Append user message
    session.messages.push({ role: 'user', content: message });

    // Dynamic title update if it's the first message of "New Chat"
    if (session.title === 'New Chat' && session.messages.length === 1) {
      session.title = message.substring(0, 30) + (message.length > 30 ? '...' : '');
    }
    await session.save();

    // 3. Format history for Groq
    const groqMessages = session.messages.map(msg => ({
      role: msg.role,
      content: msg.content
    }));

    // 4. Setup SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // 5. Begin Groq completion stream
    const chatCompletionStream = await groq.chat.completions.create({
      messages: groqMessages,
      model: 'llama-3.3-70b-versatile',
      stream: true,
    });

    let completeAssistantReply = '';

    for await (const chunk of chatCompletionStream) {
      const chunkText = chunk.choices[0]?.delta?.content || '';
      completeAssistantReply += chunkText;
      res.write(`data: ${JSON.stringify({ text: chunkText })}\n\n`);
    }

    // 6. Save final response block to database
    session.messages.push({ role: 'assistant', content: completeAssistantReply });
    await session.save();

    res.write('data: [DONE]\n\n');
    res.end();

  } catch (error) {
    console.error('Groq streaming error:', error);
    res.write(`data: ${JSON.stringify({ error: 'Failed to complete AI generation' })}\n\n`);
    res.end();
  }
});

// ==========================================
// 7. START SERVER
// ==========================================   

// For local development, still listen on PORT
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
}

// Export the app for Vercel Serverless execution
module.exports = app;