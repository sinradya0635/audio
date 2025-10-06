/* tslint:disable */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FunctionDeclaration,
  GoogleGenAI,
  LiveServerMessage,
  Modality,
  Session,
  Type,
} from '@google/genai';
import {LitElement, css, html} from 'lit';
import {customElement, state} from 'lit/decorators.js';
import {createBlob, decode, decodeAudioData, blobToBase64} from './utils';
import './visual-3d';
import {GdmLiveAudioVisuals3D} from './visual-3d';

interface TranscriptionEntry {
  speaker: 'You' | 'Gemini';
  text: string;
}

const VOICES = ['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir'];
const FRAME_RATE = 2; // fps
const JPEG_QUALITY = 0.7;

const changeColorFunction: FunctionDeclaration = {
  name: 'change_visualizer_color',
  description: 'Changes the color of the 3D sphere visualizer.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      color: {
        type: Type.STRING,
        description:
          'The color to change to. Should be a valid CSS color string, like "red", "blue", or a hex code like "#FF0000".',
      },
    },
    required: ['color'],
  },
};

@customElement('gdm-live-audio')
export class GdmLiveAudio extends LitElement {
  @state() isConversing = false;
  @state() isCameraOn = false;
  @state() isRecording = false;
  @state() sessionState: 'idle' | 'connecting' | 'connected' | 'error' =
    'idle';
  @state() status = '';
  @state() error = '';
  @state() transcriptionHistory: TranscriptionEntry[] = [];
  @state() currentUserTranscription = '';
  @state() currentModelTranscription = '';

  // Live settings
  @state() private currentVoice = 'Zephyr';
  @state() private currentSystemInstruction =
    'You are a helpful and creative AI assistant.';

  // Pending settings from UI
  @state() private pendingVoice = this.currentVoice;
  @state() private pendingSystemInstruction = this.currentSystemInstruction;

  private client: GoogleGenAI;
  private sessionPromise: Promise<Session>;
  private _currentInput = '';
  private _currentOutput = '';
  private inputAudioContext = new (window.AudioContext ||
    (window as any).webkitAudioContext)({sampleRate: 16000});
  private outputAudioContext = new (window.AudioContext ||
    (window as any).webkitAudioContext)({sampleRate: 24000});
  @state() inputNode = this.inputAudioContext.createGain();
  @state() outputNode = this.outputAudioContext.createGain();
  private nextStartTime = 0;
  private mediaStream: MediaStream;
  private videoStream: MediaStream;
  private sourceNode: MediaStreamAudioSourceNode;
  private scriptProcessorNode: ScriptProcessorNode;
  private sources = new Set<AudioBufferSourceNode>();
  private videoElement: HTMLVideoElement;
  private canvasElement: HTMLCanvasElement;
  private frameIntervalRef: number;
  private mediaRecorder: MediaRecorder;
  private recordedChunks: Blob[] = [];
  private outputDestinationNode: MediaStreamAudioDestinationNode;
  private screenStream: MediaStream | null = null;
  private recordingMixContext: AudioContext | null = null;

  static styles = css`
    :host {
      --control-button-size: 48px;
      font-family: 'Google Sans', sans-serif;
    }
    #status {
      position: absolute;
      bottom: 20px;
      left: 0;
      right: 0;
      z-index: 10;
      text-align: center;
      color: rgba(255, 255, 255, 0.7);
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
    }

    #video-preview {
      position: absolute;
      top: 20px;
      right: 20px;
      width: 200px;
      height: 150px;
      border-radius: 8px;
      object-fit: cover;
      transform: scaleX(-1); /* Mirror view */
      background: #333;
      z-index: 5;
      border: 1px solid rgba(255, 255, 255, 0.2);
      display: none;
    }

    #video-preview.active {
      display: block;
    }

    .controls-wrapper {
      z-index: 10;
      position: absolute;
      bottom: 10vh;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 20px;
    }

    .main-controls {
      display: flex;
      gap: 10px;
      align-items: center;
      background: rgba(0, 0, 0, 0.2);
      backdrop-filter: blur(10px);
      padding: 10px;
      border-radius: 16px;
      border: 1px solid rgba(255, 255, 255, 0.1);

      button {
        outline: none;
        border: 1px solid rgba(255, 255, 255, 0.2);
        color: white;
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.1);
        width: var(--control-button-size);
        height: var(--control-button-size);
        cursor: pointer;
        font-size: 24px;
        padding: 0;
        margin: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 0.2s ease;

        &:hover {
          background: rgba(255, 255, 255, 0.2);
        }
        &.active {
          background: rgba(59, 130, 246, 0.7);
        }
        &.recording {
          background: #c80000;
          animation: pulse 1.5s infinite;
        }
        &:disabled {
          opacity: 0.5;
          cursor: not-allowed;
          background: rgba(255, 255, 255, 0.05);
        }
      }

      #recordButton {
        width: 64px;
        height: 64px;
      }
    }

    @keyframes pulse {
      0% {
        box-shadow: 0 0 0 0 rgba(200, 0, 0, 0.7);
      }
      70% {
        box-shadow: 0 0 0 10px rgba(200, 0, 0, 0);
      }
      100% {
        box-shadow: 0 0 0 0 rgba(200, 0, 0, 0);
      }
    }

    .settings {
      display: flex;
      flex-direction: column;
      gap: 10px;
      background: rgba(243, 244, 246, 0.9); /* Light theme */
      backdrop-filter: blur(10px);
      padding: 15px;
      border-radius: 16px;
      border: 1px solid rgba(0, 0, 0, 0.1);
      width: 400px;
      max-width: 90vw;
      box-sizing: border-box;

      .setting-row {
        display: flex;
        align-items: center;
        gap: 10px;
        color: #1a1a1a; /* Dark text for readability */
        font-size: 14px;
      }

      label {
        width: 120px;
        flex-shrink: 0;
      }

      select,
      textarea {
        background: #ffffff;
        color: #1a1a1a;
        border: 1px solid #d1d5db;
        border-radius: 8px;
        padding: 8px 12px;
        font-size: 14px;
        outline: none;
        flex-grow: 1;
        transition: background 0.2s ease, box-shadow 0.2s ease;
        &:focus {
          box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.5);
          border-color: rgba(59, 130, 246, 0.8);
        }
      }

      select {
        -webkit-appearance: none;
        -moz-appearance: none;
        appearance: none;
        background-image: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22292.4%22%20height%3D%22292.4%22%3E%3Cpath%20fill%3D%22%23333333%22%20d%3D%22M287%2069.4a17.6%2017.6%200%200%200-13-5.4H18.4c-5%200-9.3%201.8-12.9%205.4A17.6%2017.6%200%200%200%200%2082.2c0%205%201.8%209.3%205.4%2012.9l128%20127.9c3.6%203.6%207.8%205.4%2012.8%205.4s9.2-1.8%2012.8-5.4L287%2095c3.5-3.5%205.4-7.8%205.4-12.8%200-5-1.9-9.2-5.5-12.8z%22%2F%3E%3C%2Fsvg%3E');
        background-repeat: no-repeat;
        background-position: right 12px center;
        background-size: 10px;
        padding-right: 30px;
      }

      textarea {
        height: 40px;
        resize: vertical;
      }

      button {
        cursor: pointer;
        background: #3b82f6; /* Solid blue */
        color: white;
        border: none;
        border-radius: 8px;
        padding: 10px;
        font-size: 14px;
        font-weight: 500;
        outline: none;
        transition: background 0.2s ease;
        &:hover {
          background: #2563eb;
        }
        &:disabled {
          background: #9ca3af;
          cursor: not-allowed;
          opacity: 0.8;
        }
      }
    }

    .transcription-log {
      position: absolute;
      top: 20px;
      left: 20px;
      right: 240px; /* Make space for video preview */
      bottom: 35vh;
      color: white;
      font-family: 'Roboto Mono', monospace;
      background: rgba(0, 0, 0, 0.3);
      backdrop-filter: blur(5px);
      border-radius: 8px;
      padding: 16px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 12px;
      z-index: 5;
      scrollbar-width: thin;
      scrollbar-color: rgba(255, 255, 255, 0.3) transparent;
    }
    .transcription-log .entry {
      max-width: 80%;
      padding: 8px 12px;
      border-radius: 12px;
      line-height: 1.4;
      opacity: 1;
      transition: opacity 0.3s ease-in-out;
      word-wrap: break-word;
    }
    .transcription-log .user {
      background: rgba(59, 130, 246, 0.7);
      align-self: flex-end;
      text-align: right;
    }
    .transcription-log .model {
      background: rgba(34, 197, 94, 0.7);
      align-self: flex-start;
    }
    .transcription-log .speaker {
      font-weight: bold;
      display: block;
      margin-bottom: 4px;
      font-size: 0.8em;
      opacity: 0.8;
    }
    .transcription-log .current {
      opacity: 0.6;
    }
  `;

  constructor() {
    super();
    this.initClient();
  }

  private async initClient() {
    this.nextStartTime = this.outputAudioContext.currentTime;
    this.client = new GoogleGenAI({apiKey: process.env.API_KEY});

    this.outputDestinationNode =
      this.outputAudioContext.createMediaStreamDestination();
    this.outputNode.connect(this.outputAudioContext.destination);
    this.outputNode.connect(this.outputDestinationNode);

    this.sessionPromise = this.initSession(
      this.currentVoice,
      this.currentSystemInstruction,
    );
  }

  private async initSession(
    voiceName: string,
    systemInstruction: string,
  ): Promise<Session> {
    this.sessionState = 'connecting';
    this.updateStatus('Connecting to Gemini...');

    try {
      const session = await this.client.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        callbacks: {
          onopen: () => {
            this.sessionState = 'connected';
            this.updateStatus('Connected. Press record to talk.');
            this.error = '';
          },
          onmessage: (message: LiveServerMessage) =>
            this.handleMessage(message),
          onerror: (e: ErrorEvent) => {
            this.sessionState = 'error';
            this.updateError(`Connection Error: ${e.message}`);
            this.stopConversation();
          },
          onclose: (e: CloseEvent) => {
            this.sessionState = 'idle';
            this.updateStatus('Connection closed.');
            this.stopConversation();
          },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {voiceConfig: {prebuiltVoiceConfig: {voiceName}}},
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          systemInstruction: systemInstruction,
          tools: [{functionDeclarations: [changeColorFunction]}],
        },
      });
      return session;
    } catch (e) {
      this.sessionState = 'error';
      console.error('Session Initialization Error:', e);
      this.updateError(e.message);
      return Promise.reject(e);
    }
  }

  private async handleMessage(message: LiveServerMessage) {
    if (message.toolCall) {
      for (const fc of message.toolCall.functionCalls) {
        if (fc.name === 'change_visualizer_color') {
          const color = fc.args.color as string;
          this.shadowRoot
            .querySelector<GdmLiveAudioVisuals3D>(
              'gdm-live-audio-visuals-3d',
            )
            ?.setColor(color);

          const session = await this.sessionPromise;
          session.sendToolResponse({
            functionResponses: {
              id: fc.id,
              name: fc.name,
              response: {result: `Color changed to ${color}`},
            },
          });
        }
      }
    }

    const audio = message.serverContent?.modelTurn?.parts[0]?.inlineData;
    if (audio?.data) {
      this.playAudio(audio.data);
    }

    if (message.serverContent?.inputTranscription) {
      this._currentInput += message.serverContent.inputTranscription.text;
      this.currentUserTranscription = this._currentInput;
    }
    if (message.serverContent?.outputTranscription) {
      this._currentOutput += message.serverContent.outputTranscription.text;
      this.currentModelTranscription = this._currentOutput;
    }

    if (message.serverContent?.turnComplete) {
      const history = [...this.transcriptionHistory];
      if (this._currentInput.trim())
        history.push({speaker: 'You', text: this._currentInput});
      if (this._currentOutput.trim())
        history.push({speaker: 'Gemini', text: this._currentOutput});

      this.transcriptionHistory = history;
      this._currentInput = '';
      this._currentOutput = '';
      this.currentUserTranscription = '';
      this.currentModelTranscription = '';
    }

    if (message.serverContent?.interrupted) {
      this.sources.forEach((source) => source.stop());
      this.sources.clear();
      this.nextStartTime = 0;
    }
  }

  private async playAudio(base64Audio: string) {
    this.nextStartTime = Math.max(
      this.nextStartTime,
      this.outputAudioContext.currentTime,
    );
    const audioBuffer = await decodeAudioData(
      decode(base64Audio),
      this.outputAudioContext,
      24000,
      1,
    );
    const source = this.outputAudioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.outputNode);
    source.onended = () => this.sources.delete(source);
    source.start(this.nextStartTime);
    this.nextStartTime += audioBuffer.duration;
    this.sources.add(source);
  }

  private updateStatus(msg: string) {
    this.status = msg;
    this.error = '';
  }

  private updateError(msg: string) {
    this.error = msg;
    this.status = '';
  }

  private async toggleConversation() {
    if (this.isConversing) {
      this.stopConversation();
    } else {
      await this.startConversation();
    }
  }

  private async startConversation() {
    if (this.isConversing || this.sessionState !== 'connected') return;
    await this.inputAudioContext.resume();
    this.updateStatus('Requesting microphone access...');

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      this.updateStatus('Microphone access granted.');

      this.sourceNode =
        this.inputAudioContext.createMediaStreamSource(this.mediaStream);
      this.scriptProcessorNode = this.inputAudioContext.createScriptProcessor(
        4096,
        1,
        1,
      );

      this.scriptProcessorNode.onaudioprocess = (e) => {
        if (!this.isConversing) return;
        const pcmData = e.inputBuffer.getChannelData(0);
        this.sessionPromise.then((session) => {
          session.sendRealtimeInput({media: createBlob(pcmData)});
        });
      };

      this.sourceNode.connect(this.scriptProcessorNode);
      this.scriptProcessorNode.connect(this.inputAudioContext.destination);
      this.sourceNode.connect(this.inputNode);

      this.isConversing = true;
      this.updateStatus('🔴 Listening...');
    } catch (err) {
      console.error('Error starting conversation:', err);
      this.updateError(`Microphone Error: ${err.message}`);
      this.stopConversation();
    }
  }

  private stopConversation() {
    this.stopRecording();
    if (this.isConversing) {
      this.isConversing = false;
      this.updateStatus('Conversation stopped.');
    }
    if (this.scriptProcessorNode) {
      this.scriptProcessorNode.disconnect();
      this.scriptProcessorNode = null;
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }
  }

  private async toggleCamera() {
    if (this.isCameraOn) {
      this.stopCamera();
    } else {
      await this.startCamera();
    }
  }

  private async startCamera() {
    if (this.isCameraOn) return;
    try {
      this.videoStream = await navigator.mediaDevices.getUserMedia({
        video: true,
      });
      this.videoElement.srcObject = this.videoStream;
      await this.videoElement.play();
      this.isCameraOn = true;

      const ctx = this.canvasElement.getContext('2d');
      this.frameIntervalRef = window.setInterval(() => {
        if (!this.isCameraOn) return;
        this.canvasElement.width = this.videoElement.videoWidth;
        this.canvasElement.height = this.videoElement.videoHeight;
        ctx.drawImage(
          this.videoElement,
          0,
          0,
          this.canvasElement.width,
          this.canvasElement.height,
        );
        this.canvasElement.toBlob(
          async (blob) => {
            if (blob) {
              const base64Data = await blobToBase64(blob);
              this.sessionPromise.then((session) => {
                session.sendRealtimeInput({
                  media: {data: base64Data, mimeType: 'image/jpeg'},
                });
              });
            }
          },
          'image/jpeg',
          JPEG_QUALITY,
        );
      }, 1000 / FRAME_RATE);
    } catch (err) {
      console.error('Camera error:', err);
      this.updateError(`Camera error: ${err.message}`);
      this.isCameraOn = false;
    }
  }

  private stopCamera() {
    if (!this.isCameraOn) return;
    this.isCameraOn = false;
    if (this.videoStream) {
      this.videoStream.getTracks().forEach((track) => track.stop());
      this.videoStream = null;
    }
    if (this.frameIntervalRef) {
      window.clearInterval(this.frameIntervalRef);
      this.frameIntervalRef = null;
    }
    this.videoElement.srcObject = null;
  }

  private handleVoiceChange(e: Event) {
    this.pendingVoice = (e.target as HTMLSelectElement).value;
  }

  private handleSystemInstructionChange(e: Event) {
    this.pendingSystemInstruction = (e.target as HTMLTextAreaElement).value;
  }

  private async applySettingsAndResetSession() {
    if (this.isConversing) {
      const confirmed = window.confirm(
        'Applying new settings will end the current conversation and clear the history. Proceed?',
      );
      if (!confirmed) return;
    }

    this.stopConversation();
    this.stopCamera();

    (await this.sessionPromise)?.close();

    this.currentVoice = this.pendingVoice;
    this.currentSystemInstruction = this.pendingSystemInstruction;
    this.transcriptionHistory = [];
    this.updateStatus('Settings applied. Reconnecting...');

    this.sessionPromise = this.initSession(
      this.currentVoice,
      this.currentSystemInstruction,
    );
  }

  private exportConversation() {
    if (this.transcriptionHistory.length === 0) {
      alert('No conversation to export.');
      return;
    }
    const formattedText = this.transcriptionHistory
      .map((entry) => `${entry.speaker}: ${entry.text}`)
      .join('\n\n');
    const blob = new Blob([formattedText], {type: 'text/plain;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'conversation.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  private toggleRecording() {
    if (this.isRecording) {
      this.stopRecording();
    } else {
      this.startRecording();
    }
  }

  private async startRecording() {
    if (!this.isConversing) {
      this.updateError('Start a conversation before recording.');
      return;
    }
    this.updateStatus('Requesting screen capture permission...');
    try {
      this.screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false, // We'll mix our own audio.
      });

      // Stop recording if user stops sharing via browser UI
      this.screenStream.getVideoTracks()[0].onended = () => {
        this.stopRecording();
      };

      this.recordedChunks = [];

      // Create a dedicated audio context for mixing recording streams
      this.recordingMixContext = new AudioContext();

      // Create sources from the live media streams
      const userAudioSource =
        this.recordingMixContext.createMediaStreamSource(this.mediaStream);
      const modelAudioSource =
        this.recordingMixContext.createMediaStreamSource(
          this.outputDestinationNode.stream,
        );

      // Create GainNodes to control the volume of each source
      const userGain = this.recordingMixContext.createGain();
      const modelGain = this.recordingMixContext.createGain();

      // Set gain values: Keep user volume at 100%, boost AI voice to 250%
      userGain.gain.value = 1.0;
      modelGain.gain.value = 2.5;

      // Connect the sources to their respective GainNodes
      userAudioSource.connect(userGain);
      modelAudioSource.connect(modelGain);

      // Create a destination node to merge the audio streams
      const mixedDestination =
        this.recordingMixContext.createMediaStreamDestination();

      // Connect both GainNodes to the single destination
      userGain.connect(mixedDestination);
      modelGain.connect(mixedDestination);

      const mixedAudioTrack = mixedDestination.stream.getAudioTracks()[0];
      const screenVideoTrack = this.screenStream.getVideoTracks()[0];

      // Combine the screen video with the perfectly mixed audio track
      const combinedStream = new MediaStream([
        screenVideoTrack,
        mixedAudioTrack,
      ]);

      const mimeType = 'video/webm';
      this.mediaRecorder = new MediaRecorder(combinedStream, {mimeType});

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) this.recordedChunks.push(event.data);
      };

      this.mediaRecorder.onstop = () => {
        const blob = new Blob(this.recordedChunks, {type: mimeType});
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `session-recording.webm`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        this.recordedChunks = [];
      };

      this.mediaRecorder.start();
      this.isRecording = true;
      this.updateStatus('Recording session...');
    } catch (err) {
      console.error('Error starting screen capture:', err);
      this.updateError(`Screen capture failed: ${err.message}`);
      this.isRecording = false; // Reset state
    }
  }

  private stopRecording() {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
      this.updateStatus('Recording stopped. Download will start shortly.');
    }
    if (this.screenStream) {
      this.screenStream.getTracks().forEach((track) => track.stop());
      this.screenStream = null;
    }
    if (this.recordingMixContext) {
      this.recordingMixContext.close();
      this.recordingMixContext = null;
    }
    this.isRecording = false; // Ensure state is always reset
  }

  firstUpdated() {
    this.videoElement = this.shadowRoot.querySelector('#video-preview');
    this.canvasElement = document.createElement('canvas');
  }

  updated(changedProperties: Map<string, unknown>) {
    if (
      changedProperties.has('transcriptionHistory') ||
      changedProperties.has('currentUserTranscription') ||
      changedProperties.has('currentModelTranscription')
    ) {
      const log = this.shadowRoot?.querySelector('.transcription-log');
      if (log) {
        log.scrollTop = log.scrollHeight;
      }
    }
  }

  render() {
    const settingsChanged =
      this.pendingVoice !== this.currentVoice ||
      this.pendingSystemInstruction !== this.currentSystemInstruction;

    return html`
      <div>
        <video
          id="video-preview"
          class=${this.isCameraOn ? 'active' : ''}
          muted
          playsinline
        ></video>
        <div class="transcription-log">
          ${this.transcriptionHistory.map(
            (entry) => html`
              <div class="entry ${entry.speaker === 'You' ? 'user' : 'model'}">
                <span class="speaker">${entry.speaker}</span>
                ${entry.text}
              </div>
            `,
          )}
          ${this.currentUserTranscription
            ? html`<div class="entry user current">
                <span class="speaker">You</span>${this.currentUserTranscription}
              </div>`
            : ''}
          ${this.currentModelTranscription
            ? html`<div class="entry model current">
                <span class="speaker">Gemini</span
                >${this.currentModelTranscription}
              </div>`
            : ''}
        </div>

        <div class="controls-wrapper">
          <div class="settings">
            <div class="setting-row">
              <label for="voice-select">AI Voice:</label>
              <select
                id="voice-select"
                @change=${this.handleVoiceChange}
                .value=${this.pendingVoice}
              >
                ${VOICES.map(
                  (voice) => html`<option value=${voice}>${voice}</option>`,
                )}
              </select>
            </div>
            <div class="setting-row">
              <label for="sys-instruct">System Instruction:</label>
              <textarea
                id="sys-instruct"
                .value=${this.pendingSystemInstruction}
                @input=${this.handleSystemInstructionChange}
              ></textarea>
            </div>
            <button
              @click=${this.applySettingsAndResetSession}
              ?disabled=${!settingsChanged}
            >
              Apply & Reset Session
            </button>
          </div>

          <div class="main-controls">
            <button
              id="exportButton"
              @click=${this.exportConversation}
              title="Export Conversation"
            >
              <svg
                height="24px"
                viewBox="0 -960 960 960"
                width="24px"
                fill="#ffffff"
              >
                <path
                  d="M480-320 280-520l56-58 104 104v-326h80v326l104-104 56 58-200 200ZM240-160q-33 0-56.5-23.5T160-240v-120h80v120h480v-120h80v120q0 33-23.5 56.5T720-160H240Z"
                />
              </svg>
            </button>
            <button
              id="recordButton"
              @click=${this.toggleConversation}
              ?disabled=${this.sessionState !== 'connected'}
              title=${this.isConversing
                ? 'Stop Conversation'
                : 'Start Conversation'}
            >
              ${this.isConversing
                ? html`<svg
                      viewBox="0 0 100 100"
                      width="32px"
                      height="32px"
                      fill="#ffffff"
                    >
                      <rect x="15" y="15" width="70" height="70" rx="8" />
                    </svg>`
                : html`<svg
                      viewBox="0 0 100 100"
                      width="32px"
                      height="32px"
                      fill="#c80000"
                    >
                      <circle cx="50" cy="50" r="45" />
                    </svg>`}
            </button>
            <button
              id="recordSessionButton"
              class=${this.isRecording ? 'recording' : ''}
              @click=${this.toggleRecording}
              ?disabled=${!this.isConversing}
              title=${this.isRecording
                ? 'Stop Recording Session'
                : 'Record Entire Session (Screen Capture)'}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                height="24px"
                viewBox="0 -960 960 960"
                width="24px"
                fill="#ffffff"
              >
                <path
                  d="M680-440q-25 0-42.5-17.5T620-500q0-25 17.5-42.5T680-560q25 0 42.5 17.5T740-500q0 25-17.5 42.5T680-440ZM160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h480q33 0 56.5 23.5T720-720v180l160-94v308L720-420v180q0 33-23.5 56.5T640-160H160Zm0-80h480v-480H160v480Zm0 0v-480 480Z"
                />
              </svg>
            </button>
            <button
              id="cameraButton"
              class=${this.isCameraOn ? 'active' : ''}
              @click=${this.toggleCamera}
              title=${this.isCameraOn ? 'Turn Camera Off' : 'Turn Camera On'}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                height="24px"
                viewBox="0 -960 960 960"
                width="24px"
                fill="#ffffff"
              >
                <path
                  d="m480-260-56-56 104-104-104-104 56-56 160 160-160 160ZM160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h640q33 0 56.5 23.5T880-720v480q0 33-23.5 56.5T800-160H160Zm0-80h640v-480H160v480Zm0 0v-480 480Z"
                />
              </svg>
            </button>
          </div>
        </div>

        <div id="status">${this.error || this.status}</div>
        <gdm-live-audio-visuals-3d
          .inputNode=${this.inputNode}
          .outputNode=${this.outputNode}
        ></gdm-live-audio-visuals-3d>
      </div>
    `;
  }
}
