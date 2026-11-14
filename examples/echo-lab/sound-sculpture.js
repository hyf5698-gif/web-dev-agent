/* Original parametric sound ribbon. No assets, requests or third-party runtime. */
(() => {
  'use strict';
  const TAU = Math.PI * 2;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const normalise = a => {
    const length = Math.hypot(...a) || 1;
    return a.map(n => n / length);
  };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const sub = (a, b) => a.map((n, i) => n - b[i]);
  const dot = (a, b) => a.reduce((n, value, i) => n + value * b[i], 0);

  function centre(u) {
    return [
      1.34 * Math.cos(u) + 0.19 * Math.cos(2 * u + 0.5),
      1.55 * Math.sin(u) + 0.13 * Math.sin(2 * u - 0.4),
      0.32 * Math.sin(2 * u + 0.6) + 0.16 * Math.cos(3 * u - 0.3)
    ];
  }

  function surface(u, v) {
    const c = centre(u);
    const tangent = normalise(sub(centre(u + 0.001), centre(u - 0.001)));
    let radial = [Math.cos(u), Math.sin(u), 0];
    const parallel = dot(tangent, radial);
    radial = normalise(radial.map((n, i) => n - parallel * tangent[i]));
    const binormal = normalise(cross(radial, tangent));
    const twist = u + 0.39 * Math.sin(2 * u - 0.5) + 0.28 * Math.cos(u) + 0.2;
    const width = 0.51 + 0.11 * Math.sin(u + 0.2) + 0.065 * Math.cos(3 * u - 0.7);
    const thickness = 0.067 + 0.013 * Math.cos(2 * u + 0.7);
    const wide = width * Math.cos(v);
    const edge = thickness * Math.sin(v);
    return c.map((n, i) => n + radial[i] * (wide * Math.cos(twist) - edge * Math.sin(twist)) + binormal[i] * (wide * Math.sin(twist) + edge * Math.cos(twist)));
  }

  function makeMesh() {
    const around = 280, across = 48;
    const vertices = [], positions = [], normals = [], indices = [];
    for (let i = 0; i <= around; i++) {
      for (let j = 0; j <= across; j++) {
        const u = i / around * TAU, v = j / across * TAU;
        const p = surface(u, v);
        const du = sub(surface(u + 0.0003, v), surface(u - 0.0003, v));
        const dv = sub(surface(u, v + 0.0003), surface(u, v - 0.0003));
        const n = normalise(cross(du, dv));
        positions.push(p);
        normals.push(n);
        vertices.push(...p, ...n, i / around, j / across);
        if (i < around && j < across) {
          const a = i * (across + 1) + j, b = a + across + 1;
          indices.push(a, b, a + 1, a + 1, b, b + 1);
        }
      }
    }
    return { vertices: new Float32Array(vertices), indices: new Uint16Array(indices), positions, normals };
  }

  const mesh = makeMesh();
  const rest = [0.36, -0.34, -0.41];
  function rotate(p, angles) {
    const [x, y, z] = p, [rx, ry, rz] = angles;
    const y1 = y * Math.cos(rx) - z * Math.sin(rx), z1 = y * Math.sin(rx) + z * Math.cos(rx);
    const x2 = x * Math.cos(ry) + z1 * Math.sin(ry), z2 = -x * Math.sin(ry) + z1 * Math.cos(ry);
    return [x2 * Math.cos(rz) - y1 * Math.sin(rz), x2 * Math.sin(rz) + y1 * Math.cos(rz), z2];
  }
  const bounds = mesh.positions.reduce((b, p) => {
    const q = rotate(p, rest);
    q.forEach((n, i) => { b.min[i] = Math.min(b.min[i], n); b.max[i] = Math.max(b.max[i], n); });
    return b;
  }, { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
  const offset = [-(bounds.min[0] + bounds.max[0]) / 2, -(bounds.min[1] + bounds.max[1]) / 2];

  const vertexShader = `
    attribute vec3 aPosition;
    attribute vec3 aNormal;
    attribute vec2 aUV;
    uniform vec3 uRotation;
    uniform vec2 uOffset;
    uniform float uAspect;
    uniform float uScale;
    varying vec3 vPosition;
    varying vec3 vNormal;
    varying vec2 vUV;
    void main() {
      vec3 c = cos(uRotation), s = sin(uRotation);
      mat3 rx = mat3(1.,0.,0., 0.,c.x,s.x, 0.,-s.x,c.x);
      mat3 ry = mat3(c.y,0.,-s.y, 0.,1.,0., s.y,0.,c.y);
      mat3 rz = mat3(c.z,s.z,0., -s.z,c.z,0., 0.,0.,1.);
      mat3 model = rz * ry * rx;
      vPosition = model * aPosition;
      vNormal = model * aNormal;
      vUV = aUV;
      vec2 p = (vPosition.xy + uOffset) * uScale;
      gl_Position = vec4(p.x / uAspect, p.y, -vPosition.z * .14, 1.);
    }
  `;

  const fragmentShader = `
    precision highp float;
    varying vec3 vPosition;
    varying vec3 vNormal;
    varying vec2 vUV;
    float softLight(vec3 direction, vec3 target, float sharpness) {
      return pow(max(dot(direction, normalize(target)), 0.), sharpness);
    }
    void main() {
      vec3 n = normalize(vNormal);
      vec3 eye = normalize(vec3(0., 0., 9.) - vPosition);
      vec3 r = reflect(-eye, n);
      float facing = max(dot(n, eye), 0.);
      float fresnel = pow(1. - facing, 4.);
      float upper = smoothstep(-.6, .95, r.y);
      vec3 environment = mix(vec3(.014,.021,.027), vec3(.24,.27,.28), upper);
      // Large photographic softboxes, plus narrow reflected light cards.
      // Their contrast follows the folds rather than painting the surface.
      environment += vec3(1.42,1.43,1.34) * softLight(r, vec3(-.2,.65,1.4), 4.5);
      environment += vec3(1.48,1.47,1.34) * softLight(r, vec3(.25,1.,-.85), 3.8);
      environment += vec3(.55,.60,.58) * softLight(r, vec3(.7,.8,-.5), 28.);
      environment += vec3(.94,.85,.66) * softLight(r, vec3(1.4,-.05,1.), 12.);
      environment += vec3(.28,.48,.49) * softLight(r, vec3(-1.3,-.5,.6), 15.);
      environment += vec3(.83,.91,.90) * softLight(r, vec3(.4,1.8,-.2), 32.);
      float silverBand = exp(-pow((dot(r,normalize(vec3(.91,.24,-.13)))+.12)/.075,2.));
      silverBand *= smoothstep(-.55,.15,r.z);
      float fineBand = exp(-pow((dot(r,normalize(vec3(-.25,.88,.4)))-.43)/.04,2.));
      fineBand *= smoothstep(-.2,.4,r.z);
      environment += vec3(.65,.69,.65)*silverBand + vec3(.22,.25,.24)*fineBand;
      float diffuse = .065 + .22 * max(dot(n, normalize(vec3(-.6,1.2,2.))),0.);
      diffuse += .06 * max(dot(n, normalize(vec3(1.,-.2,.3))),0.);
      vec3 silver = vec3(.58,.60,.57);
      vec3 colour = silver * diffuse + environment * (.85 + .22 * fresnel);
      float hollow = smoothstep(.45,1.7,length(vPosition.xy));
      colour *= .83 + .17 * hollow;
      float grain = fract(sin(dot(vUV * vec2(1800.,180.),vec2(12.9898,78.233))) * 43758.5453);
      colour *= .991 + grain * .018;
      colour = colour / (vec3(1.) + colour * .75);
      colour = pow(colour,vec3(.91));
      gl_FragColor = vec4(colour,1.);
    }
  `;

  function initialise(originalCanvas) {
    if (originalCanvas.dataset.sculptureInitialised) return;
    originalCanvas.dataset.sculptureInitialised = 'true';
    let canvas = originalCanvas;
    let gl = null, program = null, vertexBuffer = null, indexBuffer = null, uniforms = null;
    let frame = 0, lastFrame = -Infinity, activeTime = 0, lastTick = 0;
    let inView = true, lost = false, disposed = false, width = 1, height = 1, fallback = false;

    function dimensions() {
      const box = canvas.getBoundingClientRect();
      width = Math.max(1, box.width);
      height = Math.max(1, box.height);
      const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
      const w = Math.round(width * dpr), h = Math.round(height * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      return 1.80 / Math.max(bounds.max[1] - bounds.min[1], (bounds.max[0] - bounds.min[0]) / (width / height));
    }

    function compile(type, source) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        gl.deleteShader(shader);
        throw new Error('Sculpture shader unavailable');
      }
      return shader;
    }

    function prepare() {
      const vs = compile(gl.VERTEX_SHADER, vertexShader), fs = compile(gl.FRAGMENT_SHADER, fragmentShader);
      program = gl.createProgram();
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Sculpture programme unavailable');
      gl.useProgram(program);
      vertexBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
      [['aPosition',3,0],['aNormal',3,12],['aUV',2,24]].forEach(([name, size, start]) => {
        const location = gl.getAttribLocation(program, name);
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, size, gl.FLOAT, false, 32, start);
      });
      indexBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
      uniforms = Object.fromEntries(['uRotation','uOffset','uAspect','uScale'].map(name => [name,gl.getUniformLocation(program,name)]));
      gl.enable(gl.DEPTH_TEST);
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
      gl.clearColor(0,0,0,0);
    }

    function drawWebGL(scale, angles) {
      gl.viewport(0,0,canvas.width,canvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.useProgram(program);
      gl.uniform3fv(uniforms.uRotation, angles);
      gl.uniform2fv(uniforms.uOffset, offset);
      gl.uniform1f(uniforms.uAspect, width / height);
      gl.uniform1f(uniforms.uScale, scale);
      gl.drawElements(gl.TRIANGLES, mesh.indices.length, gl.UNSIGNED_SHORT, 0);
    }

    function drawFallback(scale) {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0,0,canvas.width,canvas.height);
      const projection = canvas.height * scale / 2;
      const rotated = mesh.positions.map(p => rotate(p,rest));
      const light = normalise([-.6,1.2,2.]);
      const faces = [];
      // A coarser static mesh keeps this graceful on devices without WebGL.
      const row = 49;
      for (let i=0;i<280;i+=2) for (let j=0;j<48;j+=2) {
        const ids = [i*row+j,(i+2)*row+j,(i+2)*row+j+2,i*row+j+2];
        const n = rotate(mesh.normals[ids[0]],rest);
        if (n[2] < -.15) continue;
        faces.push({ ids, z: ids.reduce((sum,id) => sum+rotated[id][2],0)/4, n });
      }
      faces.sort((a,b)=>a.z-b.z);
      for (const face of faces) {
        const brightness = .13 + .74 * Math.max(0,dot(face.n,light));
        const shine = Math.pow(Math.max(0,dot(face.n,normalise([-.1,.3,1]))),5);
        const crisp = Math.pow(Math.max(0,dot(face.n,normalise([-.45,.15,1]))),36);
        const warm = Math.pow(Math.max(0,dot(face.n,normalise([.7,-.1,1]))),16);
        const upper = Math.pow(Math.max(0,dot(face.n,normalise([.3,.9,.5]))),4);
        const r = Math.min(238,Math.round(138*brightness+110*shine+36*crisp+34*warm+116*upper));
        const g = Math.min(239,Math.round(145*brightness+112*shine+38*crisp+28*warm+116*upper));
        const b = Math.min(230,Math.round(142*brightness+103*shine+36*crisp+17*warm+101*upper));
        ctx.beginPath();
        face.ids.forEach((id,i)=>{
          const p=rotated[id], x=canvas.width/2+(p[0]+offset[0])*projection, y=canvas.height/2-(p[1]+offset[1])*projection;
          if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
        });
        ctx.closePath();
        ctx.fillStyle=`rgb(${r},${g},${b})`;
        ctx.strokeStyle=ctx.fillStyle;
        ctx.lineWidth=.65;
        ctx.fill();
        ctx.stroke();
      }
    }

    function draw() {
      if (disposed || lost) return;
      const scale = dimensions();
      if (fallback) drawFallback(scale);
      else {
        const t = reducedMotion.matches ? 0 : activeTime * .00012;
        drawWebGL(scale, [rest[0]+Math.sin(t*.7)*.035,rest[1]+Math.sin(t)*.075,rest[2]+Math.sin(t*.5)*.018]);
      }
      canvas.dataset.renderer = fallback ? 'canvas2d' : 'webgl';
      canvas.dataset.ready = 'true';
    }

    function tick(now) {
      frame = 0;
      if (disposed || lost || fallback || reducedMotion.matches || document.hidden || !inView) { lastTick=0; return; }
      if (now-lastFrame >= 1000/30) {
        if(lastTick) activeTime += Math.min(now-lastTick,100);
        lastTick=now;
        lastFrame=now;
        draw();
      }
      frame=requestAnimationFrame(tick);
    }

    function updatePlayback() {
      if (frame) cancelAnimationFrame(frame);
      frame=0;
      lastTick=0;
      if (!disposed && !lost && !document.hidden && inView) {
        draw();
        if(!fallback && !reducedMotion.matches) frame=requestAnimationFrame(tick);
      }
    }

    function useFallback() {
      // A canvas that already acquired WebGL cannot acquire a 2D context.
      if (gl) {
        const replacement=canvas.cloneNode(false);
        canvas.replaceWith(replacement);
        canvas=replacement;
      }
      fallback=true;
      gl=null;
    }

    try {
      gl=canvas.getContext('webgl',{alpha:true,antialias:true,premultipliedAlpha:false,powerPreference:'low-power'});
      if(gl) prepare(); else useFallback();
    } catch (_) { useFallback(); }

    canvas.addEventListener('webglcontextlost',event=>{
      event.preventDefault();
      lost=true;
      canvas.dataset.ready='false';
      if(frame) cancelAnimationFrame(frame);
      frame=0;
    });
    canvas.addEventListener('webglcontextrestored',()=>{
      try { lost=false; prepare(); updatePlayback(); }
      catch (_) { lost=true; }
    });

    const resize = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(()=>{if(inView&&!document.hidden) draw();}) : null;
    if(resize) resize.observe(canvas); else window.addEventListener('resize',draw,{passive:true});
    const visibility=typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(entries=>{
      inView=entries[0].isIntersecting;
      updatePlayback();
    },{rootMargin:'80px'}) : null;
    if(visibility) visibility.observe(canvas);
    document.addEventListener('visibilitychange',updatePlayback);
    if(reducedMotion.addEventListener) reducedMotion.addEventListener('change',updatePlayback);
    else if(reducedMotion.addListener) reducedMotion.addListener(updatePlayback);
    window.addEventListener('pagehide',()=>{
      if(frame) cancelAnimationFrame(frame);
      frame=0;
      lastTick=0;
    });
    window.addEventListener('pageshow',updatePlayback);
    draw();
    updatePlayback();
  }

  function start() { document.querySelectorAll('canvas[data-sound-sculpture]').forEach(initialise); }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',start,{once:true}); else start();
})();
