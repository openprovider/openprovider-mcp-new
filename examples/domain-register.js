/**
 * Example script demonstrating how to use the Openprovider MCP server
 * to register a new domain
 */

// Import required modules
const axios = require('axios');
const readline = require('readline');

// MCP server endpoint (assuming it's running locally)
const MCP_SERVER_URL = 'http://localhost:3000';

// Create readline interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Promisify readline question
function question(query) {
  return new Promise(resolve => {
    rl.question(query, resolve);
  });
}

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

// Example: List contacts to select owner handle
async function listContacts() {
  const args = {
    limit: 10,
    offset: 0
  };
  
  console.log('Fetching contacts...');
  const result = await callMcpServer('list_contacts', args);
  return result;
}

// Example: Check domain availability before registration
async function checkDomain(domainName, domainExtension) {
  const args = {
    domains: [
      { name: domainName, extension: domainExtension }
    ],
    with_price: true
  };
  
  console.log(`Checking availability of ${domainName}.${domainExtension}...`);
  const result = await callMcpServer('check_domain', args);
  return result;
}

// Example: Register a domain
async function registerDomain(domainName, domainExtension, ownerHandle) {
  const args = {
    domain: {
      name: domainName,
      extension: domainExtension
    },
    period: 1,
    owner_handle: ownerHandle,
    name_servers: [
      { name: "ns1.openprovider.nl" },
      { name: "ns2.openprovider.be" },
      { name: "ns3.openprovider.eu" }
    ],
    autorenew: "default"
  };
  
  console.log(`Registering domain ${domainName}.${domainExtension}...`);
  const result = await callMcpServer('register_domain', args);
  return result;
}

// Main function
async function main() {
  try {
    // First login to get authentication token
    await login();
    
    // List contacts to select owner handle
    const contactsResult = await listContacts();
    
    if (!contactsResult || !contactsResult.results || contactsResult.results.length === 0) {
      console.log('No contacts found. Please create a contact first.');
      rl.close();
      return;
    }
    
    console.log('\nAvailable Contacts:');
    console.log('==================');
    
    contactsResult.results.forEach((contact, index) => {
      console.log(`${index + 1}. ${contact.name.first_name} ${contact.name.last_name} (Handle: ${contact.handle})`);
    });
    
    // Get user input for domain registration
    const selectedContactIndex = parseInt(await question('\nSelect contact number for domain owner: ')) - 1;
    
    if (isNaN(selectedContactIndex) || selectedContactIndex < 0 || selectedContactIndex >= contactsResult.results.length) {
      console.log('Invalid selection.');
      rl.close();
      return;
    }
    
    const ownerHandle = contactsResult.results[selectedContactIndex].handle;
    const domainName = await question('Enter domain name (without extension): ');
    const domainExtension = await question('Enter domain extension (e.g., com, org, net): ');
    
    // Check domain availability
    const checkResult = await checkDomain(domainName, domainExtension);
    
    if (!checkResult || !checkResult.results || checkResult.results.length === 0) {
      console.log('Domain check failed.');
      rl.close();
      return;
    }
    
    const domainStatus = checkResult.results[0].status;
    
    if (domainStatus !== 'free') {
      console.log(`Domain ${domainName}.${domainExtension} is not available (Status: ${domainStatus}).`);
      rl.close();
      return;
    }
    
    // Show domain price
    if (checkResult.results[0].price) {
      const price = checkResult.results[0].price.reseller;
      console.log(`Domain price: ${price.price} ${price.currency}`);
    }
    
    // Confirm registration
    const confirmRegistration = await question(`Do you want to register ${domainName}.${domainExtension}? (yes/no): `);
    
    if (confirmRegistration.toLowerCase() !== 'yes') {
      console.log('Registration cancelled.');
      rl.close();
      return;
    }
    
    // Register domain
    const registrationResult = await registerDomain(domainName, domainExtension, ownerHandle);
    
    console.log('\nDomain Registration Result:');
    console.log('==========================');
    console.log(JSON.stringify(registrationResult, null, 2));
    
    console.log(`\nDomain ${domainName}.${domainExtension} registration process completed.`);
    
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    rl.close();
  }
}

// Run the main function
main();