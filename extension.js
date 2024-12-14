// extension.js
const vscode = require('vscode');
const fetch = require('node-fetch');
const { TextDecoder } = require('util');

let decorationType;

function activate(context) {
  let rewriteDisposable = vscode.commands.registerCommand('extension.rewriteText', async function () {
    await processText('rewrite');
  });

  let continueDisposable = vscode.commands.registerCommand('extension.continueText', async function () {
    await processText('continue');
  });

  context.subscriptions.push(rewriteDisposable);
  context.subscriptions.push(continueDisposable);
}

async function processText(action) {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    let selection = editor.selection;
    let selectedText = editor.document.getText(selection);

    // Adjust for 'continue' action without selection
    if (action === 'continue' && selection.isEmpty) {
      const cursorPosition = selection.active;
      selection = new vscode.Selection(cursorPosition, cursorPosition);
      selectedText = '';
    }

    if (action !== 'continue' && selectedText.trim() === '') {
      vscode.window.showInformationMessage(`Please select some text to ${action}.`);
      return;
    }

    // Fetch settings
    const config = vscode.workspace.getConfiguration('rewriteExtension');
    const {
      apiKey,
      apiEndpoint,
      model,
      systemPrompt,
      assistantPrompt,
      userPrompt,
      contextLength,
      includeSelectedTextInContext,
      contextAfterLength,
    } = getSettings(config);

    if (!apiKey && apiEndpoint.includes('api.openai.com')) {
      vscode.window.showErrorMessage('Please set your OpenAI API Key in the extension settings.');
      return;
    }

    // Extract context
    const contextBeforeText = getContextTextBefore(editor, selection, contextLength);
    const contextAfterText = getContextTextAfter(editor, selection, contextAfterLength);

    // Build messages
    const messages = buildMessages(
      systemPrompt,
      assistantPrompt,
      userPrompt,
      contextBeforeText,
      contextAfterText,
      selectedText,
      action,
      includeSelectedTextInContext
    );

    // Call API with retry logic
    const resultText = await tryCallChatCompletionAPI(apiKey, apiEndpoint, model, messages, 10);

    if (resultText) {
      if (action === 'rewrite') {
        // Replace selected text with the result
        editor.edit(editBuilder => {
          editBuilder.replace(selection, resultText);
        });
      } else if (action === 'continue') {
        // Insert result at the cursor position
        const insertPosition = selection.end;

        // Use a single edit operation
        editor.edit(editBuilder => {
          editBuilder.insert(insertPosition, resultText);
        });
      }

      // Clear any decorations
      clearEditorDecoration();
    } else {
      vscode.window.showErrorMessage(`Failed to ${action} the text after multiple attempts.`);
    }
  }
}

function getSettings(config) {
  return {
    apiKey: config.get('openAIApiKey'),
    apiEndpoint: config.get('apiEndpoint') || 'https://api.openai.com/v1',
    model: config.get('model') || 'gpt-3.5-turbo',
    systemPrompt: config.get('systemPrompt') || '',
    assistantPrompt: config.get('assistantPrompt') || '',
    userPrompt: config.get('userPrompt') || '',
    contextLength: config.get('contextLength') || 500,
    includeSelectedTextInContext: config.get('includeSelectedTextInContext') || false,
    contextAfterLength: config.get('contextAfterLength') || 200,
  };
}

function getContextTextBefore(editor, selection, contextLength) {
  const document = editor.document;
  const startPosition = new vscode.Position(0, 0);
  const contextStart = selection.start;

  const range = new vscode.Range(startPosition, contextStart);
  const textBeforeSelection = document.getText(range);

  // Trim the text to the desired context length from the end
  return textBeforeSelection.slice(-contextLength);
}

function getContextTextAfter(editor, selection, contextAfterLength) {
  const document = editor.document;
  const contextEnd = selection.end;
  const endPosition = new vscode.Position(
    document.lineCount - 1,
    document.lineAt(document.lineCount - 1).text.length
  );

  const range = new vscode.Range(contextEnd, endPosition);
  const textAfterSelection = document.getText(range);

  // Trim the text to the desired context length from the start
  return textAfterSelection.slice(0, contextAfterLength);
}

function buildMessages(
  systemPrompt,
  assistantPrompt,
  userPrompt,
  contextBeforeText,
  contextAfterText,
  selectedText,
  action,
  includeSelectedTextInContext
) {
  const messages = [];

  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }

  if (action === 'continue') {
    // User prompt from configuration
    if (userPrompt) {
      messages.push({ role: 'user', content: userPrompt });
    } else {
      messages.push({ role: 'user', content: 'Please continue.' });
    }

    // Place contextBeforeText into the assistant message
    if (contextBeforeText && contextBeforeText.trim()) {
      messages.push({ role: 'assistant', content: contextBeforeText });
    }
  } else if (action === 'rewrite') {
    // Original logic for rewrite
    let userContent = '';

    if (userPrompt) {
      userContent += `${userPrompt}\n\n`;
    }

    let contextText = '';
    if (contextBeforeText && contextBeforeText.trim()) {
      contextText += contextBeforeText;
    }

    if (includeSelectedTextInContext && selectedText.trim() !== '') {
      contextText += selectedText;
    }

    if (contextAfterText && contextAfterText.trim()) {
      contextText += contextAfterText;
    }

    if (contextText && contextText.trim()) {
      userContent += `Here is some context:\n"${contextText}"\n\n`;
    }

    // Changed "text" to "fragment"
    userContent += `Please rewrite the following fragment:\n\n"${selectedText}"`;

    messages.push({ role: 'user', content: userContent });

    // Use assistantPrompt instead of systemPrompt
    if (assistantPrompt) {
      messages.push({ role: 'assistant', content: assistantPrompt });
    }
  }

  return messages;
}

async function tryCallChatCompletionAPI(apiKey, apiEndpoint, model, messages, maxAttempts) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const resultText = await callChatCompletionAPI(apiKey, apiEndpoint, model, messages);

    if (resultText && resultText.trim() !== '') {
      return resultText;
    }

    // Optional: Add a small delay before retrying
    await delay(1000); // Delay in milliseconds

    // Optional: Log retry attempt
    console.log(`Attempt ${attempt} failed, retrying...`);
  }

  // After maxAttempts, return null
  return null;
}

async function callChatCompletionAPI(apiKey, apiEndpoint, model, messages) {
  try {
    const headers = {
      'Content-Type': 'application/json',
    };

    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const response = await fetch(`${apiEndpoint}/chat/completions`, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        model: model,
        messages: messages,
        max_tokens: 2048,
        stream: true, // Enable streaming
      }),
    });

    // Handle streaming response
    if (!response.ok) {
      const errorData = await response.json();
      vscode.window.showErrorMessage(`API Error: ${errorData.error.message}`);
      return null;
    }

    return await handleStreamResponse(response);
  } catch (error) {
    vscode.window.showErrorMessage(`Error: ${error.message}`);
    return null;
  }
}

async function handleStreamResponse(response) {
  return new Promise((resolve, reject) => {
    const decoder = new TextDecoder('utf-8');
    let resultText = '';
    let buffer = '';

    response.body.on('data', (chunk) => {
      buffer += decoder.decode(chunk, { stream: true });
      let lines = buffer.split('\n');

      // Keep the last partial line in the buffer
      buffer = lines.pop();

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine.startsWith('data: ')) {
          const data = trimmedLine.substring(6); // Remove 'data: '

          if (data === '[DONE]') {
            // Remove decoration when done
            clearEditorDecoration();
            resolve(resultText.trim());
            return;
          } else {
            try {
              const json = JSON.parse(data);
              const content = json.choices[0].delta.content;
              if (content) {
                resultText += content;
                // Update the editor decoration here
                updateEditorDecoration(resultText);
              }
            } catch (e) {
              console.error('Failed to parse JSON:', e);
            }
          }
        }
      }
    });

    response.body.on('end', () => {
      // Remove decoration in case of exit
      clearEditorDecoration();
      resolve(resultText.trim());
    });

    response.body.on('error', (error) => {
      vscode.window.showErrorMessage(`Error reading response stream: ${error.message}`);
      reject(error);
    });
  });
}

function updateEditorDecoration(text) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }

  // Create a decoration type if it doesn't exist
  if (!decorationType) {
    decorationType = vscode.window.createTextEditorDecorationType({});
  }

  // Determine where to display the decoration
  const position = editor.selection.end;

  const decoration = {
    range: new vscode.Range(position, position),
    renderOptions: {
      after: {
        contentText: text,
        color: 'gray',
        fontStyle: 'italic',
      },
    },
  };

  editor.setDecorations(decorationType, [decoration]);
}

function clearEditorDecoration() {
  const editor = vscode.window.activeTextEditor;
  if (editor && decorationType) {
    editor.setDecorations(decorationType, []);
    decorationType.dispose();
    decorationType = null;
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
};
