const MIN_NOTE = 48;
const MAX_NOTE = 84;
const LOOP_LIFETIME = 200;
const SCALE_FACTOR = 1;
const X_REPEAT_THRESHOLD = 50;
const HUMANIZE_TIME = 0.025;
const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

const MODES = {
  morning: {
    intervals: [3, 2, 2, 3, 2],
    maxVelocity: 0.3,
    bpm: 60,
    startColor: HUSL.fromHex('#2e7d32'),
    saturationShift: 20,
    lightnessShift: 10,
    reverb: 0.5,
    radiusRange: [70, 140]
  },
  evening: {
    intervals: [2, 1, 2, 2, 1, 2, 2],
    maxVelocity: 0.5,
    bpm: 80,
    startColor: HUSL.fromHex('#4fc3f7'),
    saturationShift: 0,
    lightnessShift: 0,
    reverb: 0.2,
    radiusRange: [30, 60]
  }
};

let reverb = new Tone.Convolver('https://s3-us-west-2.amazonaws.com/s.cdpn.io/969699/icel.wav').toMaster();
let piano = new Piano.Piano({
  range: [MIN_NOTE, MAX_NOTE],
  release: !iOS
}).connect(reverb);
let droneSampler = new Tone.Sampler({
  C4: 'https://s3-us-west-2.amazonaws.com/s.cdpn.io/969699/sdrone-c.mp3',
  'D#4': 'https://s3-us-west-2.amazonaws.com/s.cdpn.io/969699/sdrone-ds.mp3',
  'F#4': 'https://s3-us-west-2.amazonaws.com/s.cdpn.io/969699/sdrone-fs.mp3',
  A4: 'https://s3-us-west-2.amazonaws.com/s.cdpn.io/969699/sdrone-a.mp3'
}).connect(new Tone.Gain(0.2).connect(reverb));
let width = document.documentElement.offsetWidth;
let height = document.documentElement.offsetHeight;
let eighth = Tone.Time('8n').toSeconds();
let gridEl = document.querySelector('.grid');
let pointsEl = document.querySelector('.points');
let controlsEl = document.querySelector('.controls');
let modeButtonEls = Array.from(controlsEl.querySelectorAll('.mode'));
let backgroundEls = Array.from(document.querySelectorAll('.background'));
let loadingMessageEl = document.querySelector('.loading-message');
let introMessageEl = document.querySelector('.intro-message');
let proton = new Proton();
let particleImage = new Image();
let loops = [];
let mode;

let hueRotation = 0;
pointsEl.width = width * SCALE_FACTOR;
pointsEl.height = height * SCALE_FACTOR;
particleImage.src = 'data:image/png;base64,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';

let vae = new mm.MusicVAE(
  'https://storage.googleapis.com/download.magenta.tensorflow.org/tfjs_checkpoints/music_vae/mel_2bar_small'
);

function setMode(newMode) {
  mode = newMode;
  Tone.Transport.bpm.value = MODES[mode].bpm;
  eighth = Tone.Time('8n').toSeconds();
  reverb.wet.value = MODES[mode].reverb;
  buildGrid();
  while (loops.length) {
    loops.shift().dispose();
  }
  modeButtonEls.forEach(btnEl =>
    btnEl.classList.toggle('current', btnEl.value === newMode)
  );
  backgroundEls.forEach(el =>
    el.classList.toggle('current', el.classList.contains(newMode))
  );
  Object.keys(MODES).forEach(m => document.body.classList.remove(m));
  document.body.classList.add(newMode);
}

function buildGrid() {
  let note = MIN_NOTE,
    intervals = MODES[mode].intervals,
    i = 0;
  while (gridEl.firstChild) {
    gridEl.firstChild.remove();
  }
  while (note <= MAX_NOTE) {
    let n = note;
    let key = document.createElement('div');
    key.classList.add('key');
    key.dataset.note = n;
    gridEl.insertBefore(key, gridEl.firstChild);
    note += intervals[i++ % intervals.length];
  }
}

function easeInQuad(t) {
  return t * t;
}

function nextColor() {
  let startColor = MODES[mode].startColor;
  let satShift = MODES[mode].saturationShift;
  let ligShift = MODES[mode].lightnessShift;
  hueRotation += _.random(60, 100);
  return [
    (startColor[0] + hueRotation) % 360,
    startColor[1] + satShift,
    startColor[2] + ligShift
  ];
}

class Loop {
  constructor(vae, pair = null) {
    this.vae = vae;
    this.pair = pair;
    this.state = 'building';
    this.originalSequence = [];
    this.originalXPositions = [];
    this.genSamples = [];
    this.currInterpolation = 0;
    this.playlist = [];
    this.emitter = new Proton.Emitter();
    this.emitter.rate = new Proton.Rate(1, eighth / 4);
    this.emitter.addInitialize(new Proton.Mass(2));
    this.emitter.addInitialize(new Proton.Body(particleImage));
    let [r1, r2] = MODES[mode].radiusRange;
    this.emitter.addInitialize(
      new Proton.Radius(r1 * SCALE_FACTOR, r2 * SCALE_FACTOR)
    );
    this.emitter.addInitialize(new Proton.Life(2, 4));
    this.emitter.addInitialize(
      new Proton.Velocity(
        new Proton.Span(0.25, 0.5),
        new Proton.Span(0, 360),
        'polar'
      )
    );
    this.emitter.addBehaviour(new Proton.RandomDrift(5, 5, 0.05));
    this.emitter.addBehaviour(new Proton.Color(HUSL.toHex(...nextColor())));
    this.emitter.addBehaviour(
      new Proton.Scale(0, 1, Infinity, Proton.easeOutExpo)
    );
    this.alpha = new Proton.Alpha(0.9, 0, Infinity, Proton.easeInQuart);
    this.emitter.addBehaviour(this.alpha);
    proton.addEmitter(this.emitter);
  }

  dispose() {
    if (this.z) {
      this.z.dispose();
    }
    let emitter = this.emitter;
    setTimeout(() => {
      proton.removeEmitter(emitter);
    }, 10000);
  }

  tick(tick, currentNote, isTouching, xPos, yPos) {
    if (this.state === 'building') {
      if (!_.isNumber(this.buildingFromTick)) {
        this.buildingFromTick = tick;
      }
      let relTick = tick - this.buildingFromTick;
      let seq = this.originalSequence;
      if (
        isTouching &&
        (_.isEmpty(seq) ||
          _.last(seq).pitch !== currentNote ||
          Math.abs(_.last(seq).xPos - xPos) * width > X_REPEAT_THRESHOLD)
      ) {
        if (seq.length) {
          _.last(seq).endTime = relTick * 0.5;
        }
        seq.push({
          pitch: currentNote,
          startTime: relTick * 0.5,
          xPos
        });
        this.originalXPositions.push(xPos);
        this.updateEmitterPosition(currentNote, xPos, yPos);
        return {
          note: currentNote,
          velocity: this.getVelocity(),
          delayable: false
        };
      } else if (!isTouching) {
        if (seq.length) {
          _.last(seq).endTime = relTick * 0.5;
          this.originalSequence = mm.sequences.quantizeNoteSequence(
            { notes: seq },
            1
          );
          if (this.originalSequence.quantizationInfo) {
            this.state = 'playing';
            this.populatePlaylist(tick);
          } else {
            this.state = 'stopped';
          }
        } else {
          this.state = 'stopped';
        }
      }
    } else if (this.state === 'playing') {
      this.playingFromTick = this.playingFromTick || tick;
      while (
        this.playlist.length &&
        this.playlist[0].quantizedStartStep < tick
      ) {
        this.playlist.shift();
      }
      let noteToPlay;
      if (this.playlist.length) {
        let note = this.playlist[0];
        if (note.quantizedStartStep === tick) {
          this.playlist.shift();
          noteToPlay = {
            note: note.pitch,
            velocity: this.getVelocity(tick),
            delayable: true
          };
          this.updateEmitterPosition(note.pitch, note.xPos);
        }
      }
      if (this.playlist.length < 2) {
        this.populatePlaylist(tick);
      }
      return noteToPlay;
    }
  }

  populatePlaylist(tick) {
    let next;
    if (Math.random() < 0.4) {
      next = Promise.resolve(this.originalSequence);
    } else if (Math.random() < 0.6 && this.pair && !this.pair.isGone()) {
      if (!this.genInterpolations) {
        this.genInterpolations = this.interpolate();
      }
      next = this.genInterpolations.then(i => this.pickInterpolation(i));
    } else if (Math.random() < 0.6 && this.genSamples.length) {
      next = Promise.resolve(_.sample(this.genSamples));
    } else {
      next = this.sample();
    }
    next
      .then(nextSeq => {
        let startFrom = tick + 1;
        if (this.playlist.length) {
          startFrom = Math.max(
            tick,
            _.last(this.playlist).quantizedEndStep + 1
          );
        }
        let result = nextSeq.notes.map((note, idx) => {
          return Object.assign({}, note, {
            quantizedStartStep: note.quantizedStartStep + startFrom,
            quantizedEndStep: note.quantizedEndStep + startFrom,
            xPos: this.calculateXPos(nextSeq, idx)
          });
        });
        this.playlist = this.playlist.concat(result);
      })
      .catch(err => console.error(err));
  }

  pickInterpolation(interps) {
    let picked = interps[this.currInterpolation];
    let isFirst = this.currInterpolation === 0;
    let isLast = this.currInterpolation === interps.length - 1;
    if ((Math.random() < 0.6 || isFirst) && !isLast) {
      this.currInterpolation++;
    } else if (!isFirst) {
      this.currInterpolation--;
    }
    return picked;
  }

  calculateXPos(sequence, index) {
    let notes = sequence.notes;
    let origNotes = this.originalSequence.notes;
    let sequenceDur =
      _.last(notes).quantizedStartStep - _.first(notes).quantizedStartStep;
    let origSequenceDur =
      _.last(origNotes).quantizedStartStep -
      _.first(origNotes).quantizedStartStep;
    let noteRelPos =
      (notes[index].quantizedStartStep - _.first(notes).quantizedStartStep) /
      sequenceDur;
    for (let i = 0; i < this.originalSequence.notes.length; i++) {
      let origNote = this.originalSequence.notes[i];
      let origRelativeStep =
        origNote.quantizedStartStep - _.first(origNotes).quantizedStartStep;
      let relPos = origRelativeStep / origSequenceDur;
      if (relPos === noteRelPos) {
        return this.originalXPositions[i];
      } else if (relPos > noteRelPos) {
        if (i > 0) {
          let prevOrigNote = origNotes[i - 1];
          let prevRelPos =
            (prevOrigNote.quantizedStartStep -
              _.first(origNotes).quantizedStartStep) /
            origSequenceDur;
          let lerpAmount = (noteRelPos - prevRelPos) / (relPos - prevRelPos);
          return (
            this.originalXPositions[i - 1] +
            lerpAmount *
              (this.originalXPositions[i] - this.originalXPositions[i - 1])
          );
        } else {
          return this.originalXPositions[i];
        }
      }
    }
    return _.last(this.originalXPositions);
  }

  sample() {
    return new Promise(res =>
      setTimeout(() => {
        if (this.z) {
          this.decodeSample().then(res);
        } else {
          this.vae.encode([this.originalSequence]).then(z => {
            this.z = z;
            setTimeout(() => this.decodeSample().then(res), 0);
          });
        }
      }, 0)
    );
  }

  decodeSample(temperature = 1.4) {
    return this.vae.decode(this.z, temperature).then(recon => {
      this.genSamples.push(recon[0]);
      return recon[0];
    });
  }

  interpolate() {
    Tone.Transport.pause();
    let pausedAt = Tone.now();
    return new Promise((done, fail) => {
      setTimeout(() => {
        return this.vae
          .interpolate([this.originalSequence, this.pair.originalSequence], 5)
          .then(interps => {
            setTimeout(() => {
              let pausedFor = Tone.now() - pausedAt;
              let pausedForEighths = Math.floor(pausedFor / eighth);
              let pausedRem =
                pausedForEighths > 0
                  ? eighth - pausedFor % (eighth * pausedForEighths)
                  : eighth - pausedFor;
              Tone.Transport.start(Tone.now() + pausedRem);
              done(interps);
            }, 0);
          })
          .catch(fail);
      }, 0);
    });
  }

  getVelocity(tick = 0) {
    let maxVelocity = MODES[mode].maxVelocity;
    if (this.playingFromTick) {
      let relAge = (tick - this.playingFromTick) / LOOP_LIFETIME;
      return maxVelocity * easeInQuad(1 - relAge);
    } else {
      return maxVelocity;
    }
  }

  updateEmitterPosition(note, xPos, yPos) {
    let x = width * xPos;
    let y;
    if (yPos) {
      y = height * yPos;
    } else {
      y = height - height * (note - MIN_NOTE) / (MAX_NOTE - MIN_NOTE);
    }
    this.emitter.p.x = x * SCALE_FACTOR;
    this.emitter.p.y = y * SCALE_FACTOR;
  }

  startEmitting(tick) {
    this.alpha.reset(1 - this.getAge(tick), 0, Infinity, Proton.easeInQuart);
    this.emitter.emit();
  }

  stopEmitting() {
    this.emitter.stop();
  }

  getAge(tick) {
    if (this.playingFromTick) {
      return (tick - this.playingFromTick) / LOOP_LIFETIME;
    } else {
      return 0;
    }
  }

  isGone(tick) {
    return this.state === 'stopped' || tick - this.playingFromTick > LOOP_LIFETIME;
  }
}

function warmUp() {
  // Run some operations to get things uploaded to GPU before starting
  let s1 = { notes: [{ pitch: 60, startTime: 0, endTime: 0.5 }] };
  let s2 = { notes: [{ pitch: 80, startTime: 0, endTime: 0.5 }] };
  return vae
    .interpolate(
      [
        mm.sequences.quantizeNoteSequence(s1, 1),
        mm.sequences.quantizeNoteSequence(s2, 1)
      ],
      5
    )
    .then(() => vae.encode([mm.sequences.quantizeNoteSequence(s1, 1)]))
    .then(q => vae.decode(q));
}

function hideIntroMessage() {
  introMessageEl.style.opacity = 0;
}

Promise.all([
  piano.load('https://s3-us-west-2.amazonaws.com/s.cdpn.io/969699/'),
  vae.initialize(),
  new Promise(res => Tone.Buffer.on('load', res)),
  new Promise(res => (particleImage.onload = res))
])
  .then(warmUp)
  .then(() => {
    let currentNote,
      currentXPos = 0,
      currentYPos = 0,
      isTouching = false,
      tick = 0,
      lastAnimTime,
      notesPlayed = [],
      started = false,
      droneStarted = false,
      previousDroneNote;

    gridEl.addEventListener('mouseup', () => {
      isTouching = false;
      lastPlayedNote = null;
    });

    gridEl.addEventListener('mousemove', evt => {
      currentXPos = evt.clientX / width;
      currentYPos = evt.clientY / height;
    });

    gridEl.addEventListener('mouseover', evt => {
      if (started && evt.target.classList.contains('key')) {
        currentNote = +evt.target.dataset.note;
      }
    });
    gridEl.addEventListener('mousedown', evt => {
      if (started && evt.target.classList.contains('key')) {
        loops.push(new Loop(vae, _.last(loops)));
        isTouching = true;
        currentNote = +evt.target.dataset.note;
        hideIntroMessage();
        evt.preventDefault();
      }
    });

    gridEl.addEventListener('touchstart', evt => {
      let key = document.elementFromPoint(evt.pageX, evt.pageY);
      if (key.classList.contains('key')) {
        currentNote = +key.dataset.note;
        loops.push(new Loop(vae, _.last(loops)));
        isTouching = true;
        currentXPos = evt.pageX / width;
        currentYPos = evt.pageY / height;
        hideIntroMessage();
        evt.preventDefault();
      }
    });
    gridEl.addEventListener('touchend', evt => {
      isTouching = false;
      lastPlayedNote = null;
    });
    gridEl.addEventListener('touchmove', evt => {
      currentXPos = evt.pageX / width;
      currentYPos = evt.pageY / height;
      let key = document.elementFromPoint(evt.pageX, evt.pageY);
      if (key.classList.contains('key')) {
        currentNote = +key.dataset.note;
      }
    });

    Tone.Transport.scheduleRepeat(time => {
      let notesToPlay = new Map();
      _.forEachRight(loops, (loop, idx) => {
        if (loop.isGone(tick)) {
          loop.dispose();
          loops.splice(idx, 1);
        } else {
          let loopRes = loop.tick(
            tick,
            currentNote,
            isTouching,
            currentXPos,
            currentYPos
          );
          if (loopRes) {
            if (
              !notesToPlay.has(loopRes.note) ||
              notesToPlay.get(loopRes.note).velocity < loopRes.velocity
            ) {
              notesToPlay.set(
                loopRes.note,
                Object.assign({}, loopRes, { loop })
              );
            }
          }
        }
      });

      for (let { loop, note, velocity, delayable } of notesToPlay.values()) {
        let doDelay = delayable && notesToPlay.size > 1 && Math.random() < 0.15;
        let delay = doDelay ? eighth / 2 : 0;
        if (delay > 0) {
          velocity -= velocity / 3;
        }
        let noteTime = time + delay + HUMANIZE_TIME * Math.random();
        piano.keyUp(note, noteTime, velocity);
        piano.keyDown(note, noteTime, velocity);
        Tone.Draw.schedule(() => loop.startEmitting(tick), noteTime);
        Tone.Draw.schedule(() => loop.stopEmitting(), noteTime + eighth / 2);
        if (!droneStarted) {
          Tone.Transport.scheduleOnce(nextDrone, '+5m');
          droneStarted = true;
        }
        notesPlayed.push(note);
      }

      tick++;
      lastTickAt = time;
    }, '8n');

    function nextDrone(time) {
      if (notesPlayed.length) {
        let shiftedNotes = notesPlayed.map(n =>
          Tone.Frequency('C4')
            .transpose(n % 12)
            .toNote()
        );
        if (previousDroneNote && shiftedNotes.length > 1) {
          _.pull(shiftedNotes, previousDroneNote);
        }
        let droneNote = _.first(
          _.maxBy(_.toPairs(_.countBy(shiftedNotes)), _.last)
        );
        droneSampler.triggerAttack(droneNote, time);
        notesPlayed.length = 0;
        previousDroneNote = droneNote;
      }
      let next = _.random(25, 45);
      Tone.Transport.scheduleOnce(nextDrone, Tone.Transport.seconds + next);
    }

    requestAnimationFrame(function frame() {
      proton.update();
      requestAnimationFrame(frame);
    });

    modeButtonEls.forEach(modeBtn => {
      modeBtn.addEventListener('click', evt => setMode(evt.target.value));
    });

    window.addEventListener('resize', () => {
      width = document.documentElement.offsetWidth;
      height = document.documentElement.offsetHeight;
      pointsEl.width = width * SCALE_FACTOR;
      pointsEl.height = height * SCALE_FACTOR;
    });

    renderer = new Proton.WebGLRenderer(pointsEl);
    renderer.gl.blendFuncSeparate(
      renderer.gl.SRC_ALPHA,
      renderer.gl.ONE,
      renderer.gl.ONE,
      renderer.gl.ONE_MINUS_SRC_ALPHA
    );

    proton.addRenderer(renderer);

    setMode('morning');
   
    Tone.Transport.start();
    StartAudioContext(Tone.context, gridEl);
    controlsEl.style.opacity = 1;
    Tone.Transport.scheduleOnce(() => started = true, Tone.Transport.seconds + 0.03);
  
    loadingMessageEl.style.opacity = 0;
    loadingMessageEl.addEventListener('transitionend', () => {
      loadingMessageEl.remove();
      introMessageEl.style.opacity = 1;
    });
  });
