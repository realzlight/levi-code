export const chatState = { latestInput: '' };

export function setLatestInput(text) {
  chatState.latestInput = text;
}

export function getLatestInput() {
  return chatState.latestInput;
}
