/**
 * Example script demonstrating how to use the Openprovider MCP server
 * to check domain availability
 */

// Import required modules
const axios = require('axios');

// MCP server endpoint (assuming it's running locally)
const MCP_SERVER_URL = 'http://localhost:3000';

// Example function to call the MCP server
async function callMcpServer(toolName, args) {
  try {
    const response = await axios.post(MCP_SERVER_URL, {
      jsonrpc: '2.0',
      method: 'execute',
      params: {
        tool: toolName,
        args: args
      },
      id: 1
    });
    
    return response.data.result;
  } catch (error) {
    console.error('Error calling MCP server:', error.response?.data || error.message);
    throw error;
  }
}

// Example: Login to Openprovider
async function login() {
  const args = {
    username: process.env.OPENPROVIDER_USERNAME || 'your_username',
    password: process.env.OPENPROVIDER_PASSWORD || 'your_password'
  };
  
  console.log('Logging in to Openprovider...');
  const result = await callMcpServer('login', args);
  console.log('Login successful!');
  return result;
}

// Example: Check domain availability
async function checkDomains(domains) {
  const args = {
    domains: domains.map(domain => {
      const [name, extension] = domain.split('.');
      return { name, extension };
    }),
    with_price: true
  };
  
  console.log('Checking domain availability...');
  const result = await callMcpServer('check_domain', args);
  return result;
}

// Main function
async function main() {
  try {
    // First login to get authentication token
    await login();
    
    // Check availability of multiple domains
    const domainsToCheck = [
      'example.com',
      'example.org',
      'example.net'
    ];
    
    const result = await checkDomains(domainsToCheck);
    
    // Display results
    console.log('\nDomain Availability Results:');
    console.log('===========================');
    
    if (result && result.results) {
      result.results.forEach(domainResult => {
        console.log(`Domain: ${domainResult.domain}`);
        console.log(`Status: ${domainResult.status}`);
        
        if (domainResult.price) {
          const price = domainResult.price.reseller;
          console.log(`Price: ${price.price} ${price.currency}`);
        }
        
        if (domainResult.is_premium) {
          console.log('Premium Domain: Yes');
        }
        
        console.log('---------------------------');
      });
    } else {
      console.log('No results returned');
    }
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

// Run the main function
main();