# Troubleshooting Guide

This guide provides solutions to common issues you might encounter when using the Openprovider MCP server.

## Authentication Issues

### Authentication Failed

**Problem:** You receive an "Authentication error: Authentication/Authorization Failed" message when trying to use the login tool.

**Possible Causes:**
1. Incorrect username or password
2. Account is locked or suspended
3. IP address is not allowed to access the API

**Solutions:**
1. Double-check your username and password
2. Verify that your Openprovider account is active
3. Check if your IP address is allowed in the Openprovider control panel
4. Try logging in to the Openprovider control panel to verify your credentials

### Token Expired

**Problem:** You receive a "Token expired" or "Invalid token" error when using tools after login.

**Solutions:**
1. Call the login tool again to get a new token
2. Make sure you're using the token from the most recent login call
3. Check if your session has timed out (tokens typically expire after 30 minutes of inactivity)

## Connection Issues

### Cannot Connect to MCP Server

**Problem:** You cannot connect to the MCP server.

**Possible Causes:**
1. The server is not running
2. The server is running on a different port
3. Firewall is blocking the connection

**Solutions:**
1. Start the server using `npm start`
2. Check the server logs for any errors
3. Verify the port configuration in your .env file
4. Check your firewall settings

### Cannot Connect to Openprovider API

**Problem:** The MCP server cannot connect to the Openprovider API.

**Possible Causes:**
1. Internet connection issues
2. Openprovider API is down
3. API endpoint URL is incorrect

**Solutions:**
1. Check your internet connection
2. Verify the Openprovider API status
3. Check the API endpoint URL in your .env file

## Tool-Specific Issues

### Domain Check Fails

**Problem:** The check_domain tool fails or returns unexpected results.

**Possible Causes:**
1. Invalid domain format
2. TLD not supported by Openprovider
3. API rate limits exceeded

**Solutions:**
1. Make sure the domain name and extension are valid
2. Check if the TLD is supported by Openprovider
3. Reduce the number of domains checked in a single request
4. Wait a few minutes and try again if you've exceeded rate limits

### Domain Registration Fails

**Problem:** The register_domain tool fails.

**Possible Causes:**
1. Domain is not available
2. Missing required parameters
3. Invalid contact handle
4. Insufficient funds in your Openprovider account

**Solutions:**
1. Check domain availability before attempting registration
2. Ensure all required parameters are provided
3. Verify that the contact handle exists
4. Check your Openprovider account balance

## PearAI Agent Integration Issues

### MCP Server Not Recognized

**Problem:** PearAI Agent doesn't recognize the Openprovider MCP server.

**Possible Causes:**
1. Incorrect configuration in the MCP settings file
2. Server path is incorrect
3. Server is not executable

**Solutions:**
1. Check the MCP settings file for correct configuration
2. Verify the path to the server.js file
3. Make sure the server.js file is executable (`chmod +x server.js`)
4. Restart PearAI Agent after making changes to the MCP settings

### Tool Execution Fails

**Problem:** Tool execution fails when using the MCP server through PearAI Agent.

**Possible Causes:**
1. Server is not running
2. Environment variables not set correctly
3. Tool parameters are incorrect

**Solutions:**
1. Make sure the server is running
2. Check the environment variables in the MCP settings file
3. Verify that the tool parameters match the required schema

## Debugging

If you're still experiencing issues, you can enable debug mode to get more detailed logs:

1. Set the `DEBUG` environment variable to `true` in your .env file or MCP settings
2. Restart the server
3. Check the logs for more detailed information

Example .env file with debug mode enabled:
```
OPENPROVIDER_USERNAME=your_username
OPENPROVIDER_PASSWORD=your_password
DEBUG=true
```

## Getting Help

If you're still having issues after trying the solutions in this guide, you can:

1. Check the [Openprovider API documentation](https://docs.openprovider.com/doc/all)
2. Contact Openprovider support
3. Open an issue in the GitHub repository