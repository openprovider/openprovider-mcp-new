import { createClient, type User } from '@workos-inc/authkit-js';

// DOM Elements
const loadingState = document.getElementById('loading-state')!;
const signedOutView = document.getElementById('signed-out-view')!;
const signedInView = document.getElementById('signed-in-view')!;
const userInfo = document.getElementById('user-info')!;
const signInBtn = document.getElementById('sign-in-btn')!;
const signOutBtn = document.getElementById('sign-out-btn')!;

// Get client ID from environment
const clientId = import.meta.env.VITE_WORKOS_CLIENT_ID;

if (!clientId) {
  throw new Error('VITE_WORKOS_CLIENT_ID environment variable is required');
}

/**
 * Render the UI based on authentication state
 */
function renderAuthState(user: User | null): void {
  loadingState.classList.add('hidden');

  if (user) {
    signedOutView.classList.add('hidden');
    signedInView.classList.remove('hidden');

    userInfo.innerHTML = `
      <p><strong>Email:</strong> ${user.email ?? 'N/A'}</p>
      <p><strong>Name:</strong> ${user.firstName ?? ''} ${user.lastName ?? ''}</p>
      <p><strong>User ID:</strong> ${user.id}</p>
    `;
  } else {
    signedOutView.classList.remove('hidden');
    signedInView.classList.add('hidden');
    userInfo.innerHTML = '';
  }
}

/**
 * Initialize AuthKit client and set up event handlers
 */
async function initAuth(): Promise<void> {
  // CRITICAL: createClient is async and must be awaited
  const authkit = await createClient(clientId, {
    redirectUri: 'http://localhost:5173/callback',
    devMode: true,
  });

  // Get current user (synchronous after client init)
  const user = authkit.getUser();
  renderAuthState(user);

  // Sign in handler - must be on user gesture (click)
  signInBtn.addEventListener('click', async () => {
    try {
      await authkit.signIn();
    } catch (error) {
      console.error('Sign in failed:', error);
    }
  });

  // Sign out handler
  signOutBtn.addEventListener('click', async () => {
    try {
      await authkit.signOut();
      renderAuthState(null);
    } catch (error) {
      console.error('Sign out failed:', error);
    }
  });
}

// Initialize on DOM ready
initAuth().catch((error) => {
  console.error('Failed to initialize AuthKit:', error);
  loadingState.textContent = 'Authentication initialization failed';
});
