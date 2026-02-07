// ============================================================
// SillyTavern WhatsApp Bridge - UI Extension
// ============================================================
// Connects to the WhatsApp Bridge server plugin to enable
// two-way WhatsApp messaging with your AI characters.
// ============================================================

const MODULE_NAME = 'whatsapp_bridge';
const PLUGIN_BASE = '/api/plugins/whatsapp-bridge';

// ============================================================
// Default Settings
// ============================================================
const defaultSettings = Object.freeze({
    enabled: false,
    userPhoneNumber: '',       // The user's WhatsApp number (who receives texts)
    pollIntervalMs: 3000,      // How often to poll for incoming messages
    autoConnect: false,        // Auto-connect WhatsApp on ST load
    channelTagging: true,      // Tag messages with channel metadata
    promptInjection: true,     // Inject channel awareness into prompts
    lastTimerMinutes: null,    // Next check-in time from last bot response
    lastTimerIntent: null,     // Intent hint from last timer
    lastTimerSetAt: null,      // When the timer was set
    sceneState: 'ended',       // active | paused | ended
    sceneSummary: '',          // Brief description of current scene
});

// ============================================================
// Runtime State (not persisted)
// ============================================================
let pollInterval = null;
let qrPollInterval = null;
let timerTimeout = null;
let isProcessingIncoming = false;

// ============================================================
// Helpers
// ============================================================

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return extensionSettings[MODULE_NAME];
}

function saveSettings() {
    const { saveSettingsDebounced } = SillyTavern.getContext();
    saveSettingsDebounced();
}

/**
 * Get ST's request headers for authenticated API calls.
 * Tries multiple approaches since ST versions differ.
 */
function getHeaders() {
    // Method 1: SillyTavern context (modern ST)
    try {
        const context = SillyTavern.getContext();
        if (typeof context.getRequestHeaders === 'function') {
            return context.getRequestHeaders();
        }
    } catch (e) { /* continue */ }

    // Method 2: Global getRequestHeaders (older ST / direct export)
    try {
        if (typeof window.getRequestHeaders === 'function') {
            return window.getRequestHeaders();
        }
    } catch (e) { /* continue */ }

    // Method 3: Find CSRF token from hidden input (ST stores it this way)
    const headers = { 'Content-Type': 'application/json' };
    const csrfInput = document.getElementById('csrf_token');
    if (csrfInput?.value) {
        headers['X-CSRF-Token'] = csrfInput.value;
        return headers;
    }

    // Method 4: Check for ST's API key in sessionStorage
    const apiKey = sessionStorage.getItem('st_api_key');
    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
        return headers;
    }

    console.warn('[WhatsAppBridge] Could not find ST auth headers!');
    return headers;
}

/**
 * Make a request to the server plugin.
 * Uses ST's built-in request headers for CSRF/auth.
 */
async function pluginRequest(endpoint, method = 'GET', body = null) {
    const options = {
        method,
        headers: getHeaders(),
        credentials: 'same-origin',
    };
    if (body) {
        options.body = JSON.stringify(body);
    }
    try {
        const response = await fetch(`${PLUGIN_BASE}${endpoint}`, options);
        if (!response.ok) {
            console.error(`[WhatsAppBridge] HTTP ${response.status} from ${endpoint}`);
            return null;
        }
        return await response.json();
    } catch (err) {
        console.error(`[WhatsAppBridge] Plugin request failed: ${endpoint}`, err);
        return null;
    }
}

/**
 * Format a phone number into WhatsApp's JID format.
 * Strips non-numeric chars and appends @c.us
 */
function toWhatsAppJid(phoneNumber) {
    const cleaned = phoneNumber.replace(/[^0-9]/g, '');
    return `${cleaned}@c.us`;
}

// ============================================================
// Connection Management
// ============================================================

async function checkStatus() {
    const data = await pluginRequest('/status');
    if (!data) return null;
    updateStatusUI(data);
    return data;
}

async function connectWhatsApp() {
    updateStatusUI({ state: 'connecting' });
    const result = await pluginRequest('/connect', 'POST');
    if (result?.success) {
        startQRPolling();
    }
    return result;
}

async function disconnectWhatsApp() {
    stopMessagePolling();
    stopQRPolling();
    stopProactiveTimer();
    const result = await pluginRequest('/disconnect', 'POST');
    updateStatusUI({ state: 'disconnected' });
    return result;
}

async function logoutWhatsApp() {
    stopMessagePolling();
    stopQRPolling();
    stopProactiveTimer();
    const result = await pluginRequest('/logout', 'POST');
    updateStatusUI({ state: 'disconnected' });
    return result;
}

// ============================================================
// QR Code Polling
// ============================================================

function startQRPolling() {
    stopQRPolling();
    qrPollInterval = setInterval(async () => {
        const data = await pluginRequest('/qr');
        if (!data) return;

        const qrContainer = document.getElementById('wa_bridge_qr_container');
        const qrImage = document.getElementById('wa_bridge_qr_image');

        if (data.available && data.qr) {
            qrContainer?.classList.remove('hidden');
            if (qrImage) qrImage.src = data.qr;
        } else if (data.reason === 'already_connected') {
            stopQRPolling();
            qrContainer?.classList.add('hidden');
            onConnected();
        }
    }, 2000);
}

function stopQRPolling() {
    if (qrPollInterval) {
        clearInterval(qrPollInterval);
        qrPollInterval = null;
    }
}

// ============================================================
// Message Polling (Incoming WhatsApp → ST)
// ============================================================

function startMessagePolling() {
    const settings = getSettings();
    stopMessagePolling();
    pollInterval = setInterval(pollMessages, settings.pollIntervalMs);
    console.log(`[WhatsAppBridge] Message polling started (${settings.pollIntervalMs}ms)`);
}

function stopMessagePolling() {
    if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
    }
}

async function pollMessages() {
    if (isProcessingIncoming) return;

    const data = await pluginRequest('/messages');
    if (!data?.messages?.length) return;

    isProcessingIncoming = true;
    try {
        for (const msg of data.messages) {
            await handleIncomingMessage(msg);
        }
    } catch (err) {
        console.error('[WhatsAppBridge] Error processing incoming messages:', err);
    } finally {
        isProcessingIncoming = false;
    }
}

/**
 * Handle an incoming WhatsApp message:
 * 1. Inject it into the ST chat as a user message with channel metadata
 * 2. Trigger a bot response generation
 * 3. Send the bot's response back via WhatsApp
 */
async function handleIncomingMessage(msg) {
    const context = SillyTavern.getContext();
    const settings = getSettings();

    // No active character? Skip.
    if (context.characterId === undefined && !context.groupId) {
        console.warn('[WhatsAppBridge] No active character, skipping incoming message');
        return;
    }

    console.log(`[WhatsAppBridge] Processing incoming: "${msg.body}"`);

    // Reset any active proactive timer since user is messaging
    stopProactiveTimer();

    // Build the message text
    let messageText = msg.body || '';

    // If there's media, add a note (vision summary will be handled by RAG extension)
    if (msg.hasMedia && msg.mediaBase64) {
        const mediaType = msg.mediaMimetype?.split('/')[0] || 'file';
        messageText = messageText
            ? `[Sent a ${mediaType} via WhatsApp] ${messageText}`
            : `[Sent a ${mediaType} via WhatsApp]`;
    }

    // Use ST's built-in method to send a message as the user
    // This injects into the chat and triggers a bot response
    const textarea = document.getElementById('send_textarea');
    if (textarea) {
        textarea.value = messageText;

        // Trigger input event so ST picks it up
        textarea.dispatchEvent(new Event('input', { bubbles: true }));

        // Click the send button
        const sendButton = document.getElementById('send_but');
        if (sendButton) {
            sendButton.click();
        }
    }

    // Wait for the bot to generate a response, then send it via WhatsApp
    // We listen for the next bot message to appear in chat
    waitForBotResponse(context.chat.length).then(async (botMessage) => {
        if (botMessage && settings.userPhoneNumber) {
            const jid = toWhatsAppJid(settings.userPhoneNumber);
            await pluginRequest('/send', 'POST', {
                to: jid,
                message: botMessage,
            });
            console.log(`[WhatsAppBridge] Sent bot response to ${settings.userPhoneNumber}`);
        }
    });
}

/**
 * Wait for a new bot message to appear in the chat after a given index.
 * Polls the chat array until a new assistant message appears.
 */
function waitForBotResponse(chatLengthBefore, maxWaitMs = 120000) {
    return new Promise((resolve) => {
        const startTime = Date.now();
        const check = setInterval(() => {
            const context = SillyTavern.getContext();
            const chat = context.chat;

            // Look for new messages beyond the previous length
            if (chat.length > chatLengthBefore) {
                const newMessages = chat.slice(chatLengthBefore);
                const botMsg = newMessages.find((m) => !m.is_user && m.mes);
                if (botMsg) {
                    clearInterval(check);
                    // Clean the message (strip HTML tags for WhatsApp)
                    const cleanText = stripHtml(botMsg.mes);
                    resolve(cleanText);
                    return;
                }
            }

            // Timeout
            if (Date.now() - startTime > maxWaitMs) {
                clearInterval(check);
                console.warn('[WhatsAppBridge] Timed out waiting for bot response');
                resolve(null);
            }
        }, 500);
    });
}

/**
 * Strip HTML tags from a message for clean WhatsApp delivery.
 */
function stripHtml(html) {
    const div = document.createElement('div');
    div.innerHTML = html;
    return div.textContent || div.innerText || '';
}

// ============================================================
// Proactive Messaging Timer
// ============================================================

function startProactiveTimer(minutes, intent) {
    stopProactiveTimer();
    if (!minutes || minutes <= 0) return;

    const settings = getSettings();
    settings.lastTimerMinutes = minutes;
    settings.lastTimerIntent = intent || 'casual_followup';
    settings.lastTimerSetAt = Date.now();
    saveSettings();

    const ms = minutes * 60 * 1000;
    console.log(`[WhatsAppBridge] Proactive timer set: ${minutes}min (intent: ${intent})`);

    timerTimeout = setTimeout(async () => {
        console.log('[WhatsAppBridge] Proactive timer fired! Generating message...');
        await handleProactiveMessage(intent);
    }, ms);
}

function stopProactiveTimer() {
    if (timerTimeout) {
        clearTimeout(timerTimeout);
        timerTimeout = null;
    }
}

/**
 * Handle a proactive message: generate a text from the bot and send via WhatsApp.
 * This is called when the timer fires — the bot decides to reach out.
 */
async function handleProactiveMessage(intent) {
    const context = SillyTavern.getContext();
    const settings = getSettings();

    if (!settings.userPhoneNumber) {
        console.warn('[WhatsAppBridge] No user phone number configured');
        return;
    }

    if (context.characterId === undefined && !context.groupId) {
        console.warn('[WhatsAppBridge] No active character for proactive message');
        return;
    }

    // Use ST's quiet prompt generation to get a bot message without showing it in chat
    // We'll import generateQuietPrompt if available, otherwise fall back
    try {
        const generateQuietPrompt = (await import('../../../../script.js')).generateQuietPrompt;

        const currentTime = new Date().toLocaleString();
        const timeSinceLastMsg = getTimeSinceLastMessage();

        const proactivePrompt = buildProactivePrompt(intent, currentTime, timeSinceLastMsg);
        const botResponse = await generateQuietPrompt({ quietPrompt: proactivePrompt });

        if (botResponse) {
            // Parse the response for the message and next timer
            const parsed = parseProactiveResponse(botResponse);

            // Send the text via WhatsApp
            const jid = toWhatsAppJid(settings.userPhoneNumber);
            await pluginRequest('/send', 'POST', {
                to: jid,
                message: parsed.message,
            });

            console.log(`[WhatsAppBridge] Proactive message sent: "${parsed.message}"`);

            // Inject into ST chat history with channel tag
            injectMessageIntoChat(parsed.message, false, 'whatsapp');

            // Set the next timer if provided
            if (parsed.nextCheckinMinutes) {
                startProactiveTimer(parsed.nextCheckinMinutes, parsed.nextIntent);
            }
        }
    } catch (err) {
        console.error('[WhatsAppBridge] Proactive message generation failed:', err);
    }
}

function buildProactivePrompt(intent, currentTime, timeSinceLastMsg) {
    const settings = getSettings();
    return `[System: You are about to send a text message (WhatsApp) to the user. 
Current time: ${currentTime}
Time since last message: ${timeSinceLastMsg}
Scene state: ${settings.sceneState}
Intent hint: ${intent || 'casual_followup'}
Channel: WhatsApp text message (keep it casual, short, like a real text)

Generate your text message, then on a NEW LINE provide scheduling metadata in this exact format:
NEXT_CHECKIN_MINUTES: <number>
NEXT_INTENT: <casual_followup|worried_checkin|excited_share|continuation>

Remember: This is a text message, not a roleplay. Be natural. Be yourself as the character would be over text.]`;
}

function parseProactiveResponse(response) {
    const lines = response.trim().split('\n');
    let message = '';
    let nextCheckinMinutes = null;
    let nextIntent = 'casual_followup';

    for (const line of lines) {
        if (line.startsWith('NEXT_CHECKIN_MINUTES:')) {
            nextCheckinMinutes = parseInt(line.split(':')[1]?.trim(), 10);
        } else if (line.startsWith('NEXT_INTENT:')) {
            nextIntent = line.split(':')[1]?.trim() || 'casual_followup';
        } else {
            message += (message ? '\n' : '') + line;
        }
    }

    return { message: message.trim(), nextCheckinMinutes, nextIntent };
}

function getTimeSinceLastMessage() {
    const context = SillyTavern.getContext();
    const chat = context.chat;
    if (!chat.length) return 'No previous messages';

    const lastMsg = chat[chat.length - 1];
    if (lastMsg.send_date) {
        const then = new Date(lastMsg.send_date);
        const now = new Date();
        const diffMs = now - then;
        const diffMins = Math.floor(diffMs / 60000);
        if (diffMins < 60) return `${diffMins} minutes ago`;
        const diffHrs = Math.floor(diffMins / 60);
        if (diffHrs < 24) return `${diffHrs} hours ago`;
        return `${Math.floor(diffHrs / 24)} days ago`;
    }
    return 'Unknown';
}

/**
 * Inject a message directly into the chat log with metadata.
 */
function injectMessageIntoChat(text, isUser, channel) {
    const context = SillyTavern.getContext();
    const chat = context.chat;

    const newMessage = {
        name: isUser ? context.name1 : context.name2,
        is_user: isUser,
        mes: text,
        send_date: new Date().toISOString(),
        extra: {
            wa_bridge: {
                channel: channel || 'whatsapp',
                timestamp: Date.now(),
            },
        },
    };

    chat.push(newMessage);
}

// ============================================================
// Prompt Injection (Channel Awareness)
// ============================================================

/**
 * Intercept generation requests to inject channel awareness.
 * This is registered via the generate_interceptor in manifest,
 * or we hook into the event system.
 */
function setupPromptInjection() {
    const context = SillyTavern.getContext();

    // Listen for chat-completion events to inject channel context
    context.eventSource.on(context.eventTypes.GENERATION_STARTED, (data) => {
        const settings = getSettings();
        if (!settings.promptInjection || !settings.enabled) return;

        // We'll handle injection via the chat array manipulation
        // The actual prompt building picks up from the chat array
    });

    // After a bot message is generated, parse it for timer metadata
    context.eventSource.on(context.eventTypes.MESSAGE_RECEIVED, (messageIndex) => {
        const settings = getSettings();
        if (!settings.enabled) return;

        const chat = SillyTavern.getContext().chat;
        const msg = chat[messageIndex];
        if (!msg || msg.is_user) return;

        // Check if the response contains timer metadata
        // (This would be in the bot's response if we instructed it to include scheduling)
        parseAndSetTimer(msg.mes);
    });
}

/**
 * Look for scheduling metadata in a bot's response.
 * Format: NEXT_CHECKIN_MINUTES: <number>
 */
function parseAndSetTimer(messageText) {
    if (!messageText) return;

    const checkinMatch = messageText.match(/NEXT_CHECKIN_MINUTES:\s*(\d+)/);
    const intentMatch = messageText.match(/NEXT_INTENT:\s*(\w+)/);

    if (checkinMatch) {
        const minutes = parseInt(checkinMatch[1], 10);
        const intent = intentMatch ? intentMatch[1] : 'casual_followup';

        if (minutes > 0) {
            startProactiveTimer(minutes, intent);
        }
    }
}

// ============================================================
// Connection Lifecycle
// ============================================================

function onConnected() {
    const settings = getSettings();
    startMessagePolling();
    updateStatusUI({ state: 'connected' });

    // Restore proactive timer if one was set
    if (settings.lastTimerMinutes && settings.lastTimerSetAt) {
        const elapsed = (Date.now() - settings.lastTimerSetAt) / 60000;
        const remaining = settings.lastTimerMinutes - elapsed;
        if (remaining > 0) {
            startProactiveTimer(remaining, settings.lastTimerIntent);
        } else {
            // Timer already expired, fire immediately
            handleProactiveMessage(settings.lastTimerIntent);
        }
    }
}

// ============================================================
// UI
// ============================================================

function updateStatusUI(data) {
    const stateEl = document.getElementById('wa_bridge_status');
    const indicator = document.getElementById('wa_bridge_indicator');
    const connectBtn = document.getElementById('wa_bridge_connect_btn');
    const disconnectBtn = document.getElementById('wa_bridge_disconnect_btn');
    const logoutBtn = document.getElementById('wa_bridge_logout_btn');
    const qrContainer = document.getElementById('wa_bridge_qr_container');
    const infoEl = document.getElementById('wa_bridge_client_info');

    if (!stateEl) return;

    const state = data?.state || 'disconnected';

    // Status text and indicator color
    const stateLabels = {
        disconnected: 'Disconnected',
        connecting: 'Connecting...',
        qr_pending: 'Scan QR Code',
        connected: 'Connected',
        error: 'Error',
    };

    stateEl.textContent = stateLabels[state] || state;
    if (indicator) {
        indicator.className = 'wa_bridge_indicator';
        indicator.classList.add(`wa_bridge_indicator--${state}`);
    }

    // Button visibility
    if (connectBtn) connectBtn.classList.toggle('hidden', state === 'connected' || state === 'connecting' || state === 'qr_pending');
    if (disconnectBtn) disconnectBtn.classList.toggle('hidden', state !== 'connected');
    if (logoutBtn) logoutBtn.classList.toggle('hidden', state !== 'connected');
    if (qrContainer) qrContainer.classList.toggle('hidden', state !== 'qr_pending');

    // Client info
    if (infoEl && data?.clientInfo) {
        infoEl.textContent = `${data.clientInfo.pushname} (${data.clientInfo.wid})`;
        infoEl.classList.remove('hidden');
    } else if (infoEl) {
        infoEl.classList.add('hidden');
    }
}

function createSettingsUI() {
    const settingsHtml = `
    <div id="wa_bridge_settings" class="wa_bridge_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>WhatsApp Bridge</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <!-- Connection Status -->
                <div class="wa_bridge_status_row">
                    <span class="wa_bridge_indicator wa_bridge_indicator--disconnected" id="wa_bridge_indicator"></span>
                    <span id="wa_bridge_status">Disconnected</span>
                    <span id="wa_bridge_client_info" class="wa_bridge_client_info hidden"></span>
                </div>

                <!-- QR Code Display -->
                <div id="wa_bridge_qr_container" class="wa_bridge_qr_container hidden">
                    <p class="wa_bridge_qr_label">Scan with your bot's WhatsApp:</p>
                    <img id="wa_bridge_qr_image" class="wa_bridge_qr_image" src="" alt="QR Code" />
                </div>

                <!-- Connection Buttons -->
                <div class="wa_bridge_button_row">
                    <input id="wa_bridge_connect_btn" class="menu_button" type="button" value="Connect WhatsApp" />
                    <input id="wa_bridge_disconnect_btn" class="menu_button hidden" type="button" value="Disconnect" />
                    <input id="wa_bridge_logout_btn" class="menu_button menu_button_danger hidden" type="button" value="Logout" />
                </div>

                <hr class="wa_bridge_divider" />

                <!-- Settings -->
                <div class="wa_bridge_setting">
                    <label for="wa_bridge_enabled">
                        <input id="wa_bridge_enabled" type="checkbox" />
                        <span>Enable WhatsApp Bridge</span>
                    </label>
                </div>

                <div class="wa_bridge_setting">
                    <label for="wa_bridge_auto_connect">
                        <input id="wa_bridge_auto_connect" type="checkbox" />
                        <span>Auto-connect on startup</span>
                    </label>
                </div>

                <div class="wa_bridge_setting">
                    <label for="wa_bridge_prompt_injection">
                        <input id="wa_bridge_prompt_injection" type="checkbox" />
                        <span>Channel-aware prompts</span>
                    </label>
                </div>

                <div class="wa_bridge_setting">
                    <label for="wa_bridge_phone_number">Your Phone Number</label>
                    <small class="wa_bridge_hint">Include country code, e.g. 15551234567</small>
                    <input id="wa_bridge_phone_number" type="text" class="text_pole" placeholder="15551234567" />
                </div>

                <div class="wa_bridge_setting">
                    <label for="wa_bridge_poll_interval">Poll Interval (ms)</label>
                    <small class="wa_bridge_hint">How often to check for new WhatsApp messages</small>
                    <input id="wa_bridge_poll_interval" type="number" class="text_pole" min="1000" max="30000" step="500" />
                </div>

                <hr class="wa_bridge_divider" />

                <!-- Scene State (informational) -->
                <div class="wa_bridge_setting">
                    <label>Scene State</label>
                    <div class="wa_bridge_scene_info">
                        <span id="wa_bridge_scene_state" class="wa_bridge_scene_badge">ended</span>
                        <span id="wa_bridge_scene_summary" class="wa_bridge_scene_summary"></span>
                    </div>
                </div>

                <!-- Timer Info (informational) -->
                <div class="wa_bridge_setting">
                    <label>Proactive Timer</label>
                    <div id="wa_bridge_timer_info" class="wa_bridge_timer_info">No timer active</div>
                </div>
            </div>
        </div>
    </div>`;

    // Append to the extensions settings container
    const container = document.getElementById('extensions_settings');
    if (container) {
        container.insertAdjacentHTML('beforeend', settingsHtml);
    }

    // Bind events
    bindSettingsEvents();
}

function bindSettingsEvents() {
    const settings = getSettings();

    // Connect button
    document.getElementById('wa_bridge_connect_btn')?.addEventListener('click', () => {
        connectWhatsApp();
    });

    // Disconnect button
    document.getElementById('wa_bridge_disconnect_btn')?.addEventListener('click', () => {
        disconnectWhatsApp();
    });

    // Logout button
    document.getElementById('wa_bridge_logout_btn')?.addEventListener('click', () => {
        if (confirm('This will log out the WhatsApp session. You\'ll need to scan the QR code again. Continue?')) {
            logoutWhatsApp();
        }
    });

    // Enabled checkbox
    const enabledEl = document.getElementById('wa_bridge_enabled');
    if (enabledEl) {
        enabledEl.checked = settings.enabled;
        enabledEl.addEventListener('change', () => {
            settings.enabled = enabledEl.checked;
            saveSettings();
        });
    }

    // Auto-connect checkbox
    const autoConnectEl = document.getElementById('wa_bridge_auto_connect');
    if (autoConnectEl) {
        autoConnectEl.checked = settings.autoConnect;
        autoConnectEl.addEventListener('change', () => {
            settings.autoConnect = autoConnectEl.checked;
            saveSettings();
        });
    }

    // Prompt injection checkbox
    const promptInjEl = document.getElementById('wa_bridge_prompt_injection');
    if (promptInjEl) {
        promptInjEl.checked = settings.promptInjection;
        promptInjEl.addEventListener('change', () => {
            settings.promptInjection = promptInjEl.checked;
            saveSettings();
        });
    }

    // Phone number
    const phoneEl = document.getElementById('wa_bridge_phone_number');
    if (phoneEl) {
        phoneEl.value = settings.userPhoneNumber;
        phoneEl.addEventListener('input', () => {
            settings.userPhoneNumber = phoneEl.value.trim();
            saveSettings();
        });
    }

    // Poll interval
    const pollEl = document.getElementById('wa_bridge_poll_interval');
    if (pollEl) {
        pollEl.value = settings.pollIntervalMs;
        pollEl.addEventListener('change', () => {
            settings.pollIntervalMs = parseInt(pollEl.value, 10) || 3000;
            saveSettings();
            // Restart polling with new interval if active
            if (pollInterval) {
                startMessagePolling();
            }
        });
    }
}

function updateTimerUI() {
    const settings = getSettings();
    const timerInfoEl = document.getElementById('wa_bridge_timer_info');
    if (!timerInfoEl) return;

    if (timerTimeout && settings.lastTimerMinutes) {
        const elapsed = (Date.now() - settings.lastTimerSetAt) / 60000;
        const remaining = Math.max(0, settings.lastTimerMinutes - elapsed);
        timerInfoEl.textContent = `Next check-in in ~${Math.round(remaining)}min (${settings.lastTimerIntent || 'casual'})`;
    } else {
        timerInfoEl.textContent = 'No timer active';
    }
}

// ============================================================
// Extension Entry Point
// ============================================================

(async function () {
    // Create the settings UI
    createSettingsUI();

    // Set up prompt injection hooks
    setupPromptInjection();

    // Check initial connection status
    const status = await checkStatus();

    // If already connected (e.g. server was running), start polling
    if (status?.state === 'connected') {
        onConnected();
    }

    // Auto-connect if enabled
    const settings = getSettings();
    if (settings.autoConnect && status?.state === 'disconnected') {
        console.log('[WhatsAppBridge] Auto-connecting...');
        await connectWhatsApp();
    }

    // Update timer UI periodically
    setInterval(updateTimerUI, 10000);

    console.log('[WhatsAppBridge] UI extension loaded.');
})();
