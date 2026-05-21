/**
 * Simple test script to verify that the Openprovider MCP server is working correctly
 */

// Import required modules
const axios = require('axios');

// MCP server endpoint (assuming it's running locally)
const MCP_SERVER_URL = 'http://localhost:3000';

// Test function to call the MCP server
async function testMcpServer() {
  try {
    // Test the server's health endpoint
    console.log('Testing MCP server health...');
    const healthResponse = await axios.post(MCP_SERVER_URL, {
      jsonrpc: '2.0',
      method: 'health',
      id: 1
    });
    
    console.log('Health check response:', healthResponse.data);
    
    // Test the server's describe endpoint
    console.log('\nTesting MCP server describe...');
    const describeResponse = await axios.post(MCP_SERVER_URL, {
      jsonrpc: '2.0',
      method: 'describe',
      id: 2
    });
    
    console.log('Server name:', describeResponse.data.result.name);
    console.log('Server description:', describeResponse.data.result.description);
    console.log('Available tools:');
    
    const tools = describeResponse.data.result.tools;
    Object.keys(tools).forEach(toolName => {
      console.log(`- ${toolName}: ${tools[toolName].description}`);
    });
    
    console.log('\nMCP server is working correctly!');
    
  } catch (error) {
    console.error('Error testing MCP server:', error.response?.data || error.message);
    
    if (error.code === 'ECONNREFUSED') {
      console.error('\nMake sure the MCP server is running. Start it with:');
      console.error('npm start');
    }
  }
}

// Run the test function
testMcpServer();