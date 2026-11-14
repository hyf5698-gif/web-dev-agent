(() => {
  'use strict';
  const explorer = document.querySelector('.color-explorer');
  const paletteLabel = document.querySelector('#palette-label');
  const productStage = document.querySelector('.color-product-stage');
  const palettes = {
    gold: { label: '暖金 · 温润的光', image: document.querySelector('#color-product-image'), alt: '暖金色 iPhone 20 概念机身，搭配琥珀流光正面屏幕' },
    graphite: { label: '石墨 · 沉静的光', image: document.querySelector('#color-product-graphite'), alt: '石墨色 iPhone 20 概念机身，搭配琥珀流光正面屏幕' }
  };
  // Keep both decoded photographs in one fixed frame. CSS can reverse a fade
  // from its current opacity without replacing the source or exposing a blank.
  Object.values(palettes).forEach(palette => {
    palette.ready = palette.image.decode().then(() => true, () => false);
  });
  let colorRequest = 0;
  document.querySelectorAll('[data-color]').forEach(button => {
    button.addEventListener('click', async () => {
      const color = button.dataset.color;
      const palette = palettes[color];
      if (!palette) return;
      const request = ++colorRequest;
      const loaded = await palette.ready;
      if (request !== colorRequest) return;
      if (!loaded) {
        paletteLabel.textContent = '图片暂时无法加载，请刷新后重试。';
        return;
      }
      explorer.dataset.palette = color;
      productStage.setAttribute('aria-label', palette.alt);
      paletteLabel.textContent = palette.label;
      document.querySelectorAll('[data-color]').forEach(option => option.setAttribute('aria-pressed', String(option === button)));
    });
  });

  const dialog = document.querySelector('#concept-dialog');
  document.querySelectorAll('[data-open-concept]').forEach(button => button.addEventListener('click', () => dialog.showModal()));
  dialog.addEventListener('click', event => {
    const rect = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
  });
  document.querySelector('#dialog-explore').addEventListener('click', () => {
    dialog.close();
    document.querySelector('#design').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  });

  const canvas = document.querySelector('#light-canvas');
  const section = document.querySelector('.light-experience');
  const toggle = document.querySelector('#motion-toggle');
  const context = canvas.getContext('2d');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let paused = motion.matches;
  let frame = 0;
  let width = 0;
  let height = 0;
  let time = 0;
  let lastTime = 0;
  let pointer = { x: .52, y: .52 };
  let current = { ...pointer };
  let visible = true;

  function paint() {
    if (!context) return;
    context.clearRect(0, 0, width, height);
    const centerX = width * (.45 + (current.x - .5) * .2);
    const centerY = height * (.66 + (current.y - .5) * .12);
    const glow = context.createRadialGradient(centerX, centerY, 0, centerX, centerY, width * .55);
    glow.addColorStop(0, 'rgba(166,86,19,.15)');
    glow.addColorStop(.45, 'rgba(111,52,10,.06)');
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    context.fillStyle = glow;
    context.fillRect(0, 0, width, height);
    context.globalCompositeOperation = 'lighter';
    for (let ribbon = 0; ribbon < 4; ribbon++) {
      for (let strand = 0; strand < 13; strand++) {
        const phase = time * .26 + ribbon * .75;
        const offset = strand * 2.1 + ribbon * 17;
        const bend = Math.sin(phase) * height * .07;
        context.beginPath();
        context.moveTo(-width * .1, height * .91 + offset);
        context.bezierCurveTo(width * .23, height * .91 - offset - bend, width * .25 + current.x * width * .22, height * .17 + offset + bend, width * 1.12, height * (.46 + ribbon * .035) + (current.y - .5) * 130);
        const gradient = context.createLinearGradient(0, 0, width, 0);
        gradient.addColorStop(0, 'rgba(135,62,14,0)');
        gradient.addColorStop(.35, `rgba(199,105,37,${.1 + strand * .008})`);
        gradient.addColorStop(.58, `rgba(255,195,112,${.16 + strand * .013})`);
        gradient.addColorStop(.82, `rgba(223,126,48,${.12 + strand * .008})`);
        gradient.addColorStop(1, 'rgba(170,78,18,0)');
        context.strokeStyle = gradient;
        context.lineWidth = strand === 6 ? 2.2 : .7;
        context.stroke();
      }
    }
    context.globalCompositeOperation = 'source-over';
  }

  function animate(timestamp) {
    frame = 0;
    if (paused || !visible || document.hidden) return;
    const delta = lastTime ? Math.min(timestamp - lastTime, 50) : 16;
    lastTime = timestamp;
    time += delta / 1000;
    current.x += (pointer.x - current.x) * .045;
    current.y += (pointer.y - current.y) * .045;
    paint();
    frame = requestAnimationFrame(animate);
  }
  function schedule() {
    if (!frame && !paused && visible && !document.hidden) { lastTime = 0; frame = requestAnimationFrame(animate); }
  }
  function updateControl() {
    toggle.setAttribute('aria-pressed', String(paused));
    toggle.querySelector('.motion-label').textContent = paused ? '播放流光' : '暂停流光';
    toggle.querySelector('.motion-symbol').textContent = paused ? '▷' : 'Ⅱ';
    section.dataset.paused = String(paused);
  }
  function resize() {
    width = section.clientWidth;
    height = section.clientHeight;
    const ratio = Math.min(devicePixelRatio || 1, 1.75);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context?.setTransform(ratio, 0, 0, ratio, 0, 0);
    paint();
  }
  section.addEventListener('pointermove', event => {
    if (motion.matches || paused) return;
    const rect = section.getBoundingClientRect();
    pointer.x = (event.clientX - rect.left) / rect.width;
    pointer.y = (event.clientY - rect.top) / rect.height;
  }, { passive: true });
  section.addEventListener('pointerdown', event => {
    if (motion.matches || paused || event.target.closest('button')) return;
    const rect = section.getBoundingClientRect();
    pointer = { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
  }, { passive: true });
  toggle.addEventListener('click', () => {
    paused = !paused;
    if (paused) { cancelAnimationFrame(frame); frame = 0; }
    updateControl();
    schedule();
  });
  motion.addEventListener('change', () => {
    paused = motion.matches;
    cancelAnimationFrame(frame);
    frame = 0;
    updateControl();
    paint();
    schedule();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { cancelAnimationFrame(frame); frame = 0; } else schedule(); });
  new ResizeObserver(resize).observe(section);
  new IntersectionObserver(entries => { visible = entries[0].isIntersecting; if (!visible) { cancelAnimationFrame(frame); frame = 0; } else schedule(); }).observe(section);
  updateControl();
  resize();
  schedule();
})();
