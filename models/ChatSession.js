// models/ChatSession.js
const mongoose = require('mongoose');

// Schema for individual messages in a conversation
const MessageSchema = new mongoose.Schema({
  role: { 
    type: String, 
    enum: ['user', 'assistant'], // Limits options strictly to user queries and AI assistant answers
    required: true 
  },
  content: { 
    type: String, 
    required: true 
  },
  timestamp: { 
    type: Date, 
    default: Date.now 
  }
});

// Schema for the chat session holding the messages
const ChatSessionSchema = new mongoose.Schema({
  title: { 
    type: String, 
    default: 'New Chat' 
  },
  messages: [MessageSchema], // Embeds the array of messages
  createdAt: { 
    type: Date, 
    default: Date.now 
  }
});

module.exports = mongoose.model('ChatSession', ChatSessionSchema);