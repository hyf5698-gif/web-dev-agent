const joinButton = document.getElementById('join');
const confirmation = document.getElementById('confirmation');
joinButton.addEventListener('click', () => confirmation.showModal());
confirmation.addEventListener('click', (event) => {
  if (event.target === confirmation) {
    const rect = confirmation.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) confirmation.close();
  }
});
const prompts = [
  '如果用一句话，留住今天的街道，你会写下什么？',
  '有没有一扇窗，让你想象过窗后的人怎样生活？',
  '同一条路，清晨与傍晚的光，会讲出不同的故事吗？'
];
let promptIndex = 0;
const promptQuestion = document.getElementById('prompt-question');
document.getElementById('next-prompt').addEventListener('click', () => {
  promptIndex = (promptIndex + 1) % prompts.length;
  promptQuestion.textContent = prompts[promptIndex];
  document.getElementById('prompt-count').textContent = `${String(promptIndex + 1).padStart(2, '0')} / 03`;
});
promptQuestion.setAttribute('aria-live', 'polite');
