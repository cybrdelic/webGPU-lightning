








import React, { useRef, useEffect, useState, forwardRef, useImperativeHandle } from 'react';
import { ShaderError, ShaderParam, VideoConfig } from '../types';
import { calculateUniformLayout, writeParamsToBuffer, ParamsControlPanel } from './ShaderParams';

function getErrorMessage(err: any): string {
  if (err === undefined) return "Undefined Error";
  if (err === null) return "Null Error";
  if (typeof err === 'string') return err;
  
  // Handle GPUValidationError specifically
  if (err.constructor && err.constructor.name === 'GPUValidationError') {
      return `Validation Error: ${err.message}`;
  }
  
  if (err.reason !== undefined && err.message !== undefined) return `Device Lost (${err.reason}): ${err.message}`;
  if (err.message !== undefined) return String(err.message);
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  
  try { 
      // recursive stringify for deep objects
      const json = JSON.stringify(err, null, 2); 
      if (json !== '{}') return json; 
  } catch (e) {
      // ignore
  }
  return String(err);
}

export interface WebGPURendererRef {
  capture: (quality?: number) => void;
  startVideo: (config: VideoConfig) => void;
  stopVideo: () => void;
  loadTexture: (file: File) => void;
  toggleAudio: () => Promise<void>;
}

interface WebGPURendererProps {
  shaderCode: string;
  description?: string;
  onError: (error: ShaderError) => void;
  onClearError: () => void;
  onRecordProgress: (isRecording: boolean, timeLeft: number) => void;
}

const WebGPURenderer = forwardRef<WebGPURendererRef, WebGPURendererProps>(({ shaderCode, description, onError, onClearError, onRecordProgress }, ref) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isSupported, setIsSupported] = useState<boolean>(true);
  
  const deviceRef = useRef<any>(null);
  const contextRef = useRef<any>(null);
  const pipelineRef = useRef<any>(null);
  const uniformBufferRef = useRef<any>(null);
  const bindGroupRef = useRef<any>(null);
  const textureRef = useRef<any>(null); // Channel 0
  const samplerRef = useRef<any>(null); // Sampler
  
  const requestRef = useRef<number | null>(null);
  const startTimeRef = useRef<number>(performance.now());
  const isMountedRef = useRef<boolean>(true);
  const errorReportedRef = useRef<boolean>(false);
  
  // Audio State
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyzerRef = useRef<AnalyserNode | null>(null);
  const audioDataArrayRef = useRef<Uint8Array | null>(null);

  // Capture State
  const capturePendingRef = useRef<number>(0); // 0 = None, 1 = HQ, 2 = Ultra
  
  // Video Recording State
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordingConfigRef = useRef<VideoConfig | null>(null);
  const recordingStartTimeRef = useRef<number>(0);
  const isRecordingRef = useRef<boolean>(false);
  const recordedFramesRef = useRef<number>(0); // For deterministic timing
  const streamTrackRef = useRef<any>(null); // For manual frame capturing

  // --- EASY PARAM WIRING ---
  const [params, setParams] = useState<ShaderParam[]>([
    { id: 'animSpeed', label: 'Animation Speed', type: 'float', value: 0.2, min: 0.0, max: 2.0 },
    { id: 'detail', label: 'Roughness / Detail', type: 'float', value: 0.35, min: 0.01, max: 1.0 },
    { id: 'vignette', label: 'Vignette', type: 'float', value: 0.2, min: 0.0, max: 1.0 },
    { id: 'metallic', label: 'Metallic', type: 'float', value: 1.0, min: 0.0, max: 1.0 },
    { id: 'baseColor', label: 'Base Color', type: 'color', value: [0.8, 0.8, 0.85] }, // Silver
    { id: 'grainStrength', label: 'Film Grain', type: 'float', value: 0.00, min: 0.0, max: 0.2 },
    { id: 'lightAz', label: 'Light Azimuth', type: 'float', value: 0.1, min: 0.0, max: 1.0 },
    { id: 'lightEl', label: 'Light Elevation', type: 'float', value: 0.6, min: 0.0, max: 1.0 },
    { id: 'isRendering', label: 'Debug Quality', type: 'float', value: 0.0, min: 0.0, max: 2.0 }, // Hidden usually
    { id: 'aberrationStrength', label: 'Chr. Aberration', type: 'float', value: 0.00, min: 0.0, max: 2.0 },
    
    // NEW PARAMS - Updated for electricity defaults
    { id: 'electricSpeed', label: 'Arc Speed', type: 'float', value: 0.8, min: 0.0, max: 5.0 }, // Fast sparking
    { id: 'electricIntensity', label: 'Arc Intensity', type: 'float', value: 12.0, min: 0.0, max: 30.0 }, // Very Bright
    { id: 'electricColor', label: 'Arc Color', type: 'color', value: [0.1, 0.6, 1.0] },
  ]);

  const paramsRef = useRef(params);
  useEffect(() => { paramsRef.current = params; }, [params]);

  // Standard Header Size: 48 bytes
  const layout = calculateUniformLayout(params, 48);
  
  const cameraState = useRef({ theta: 0.5, phi: 0.3, radius: 4.5, isDragging: false, lastX: 0, lastY: 0 });
  const mouseState = useRef({ x: 0, y: 0, isDown: 0 });

  // --- HELPER: Texture Creation ---
  const createTextureFromImage = async (device: any, source: ImageBitmap | HTMLCanvasElement) => {
    // Usage: TEXTURE_BINDING (4) | COPY_DST (2) | COPY_SRC (1) | RENDER_ATTACHMENT (16) = 23
    const texture = device.createTexture({
        size: [source.width, source.height, 1],
        format: 'rgba8unorm',
        usage: 23, 
    });
    device.queue.copyExternalImageToTexture(
        { source },
        { texture },
        [source.width, source.height]
    );
    return texture;
  };
  
  const createDefaultTexture = (device: any) => {
      const size = 64;
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (ctx) {
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, size, size);
          ctx.fillStyle = '#333';
          for(let y=0; y<size; y+=8) {
              for(let x=0; x<size; x+=8) {
                  if ((x/8 + y/8) % 2 === 0) ctx.fillRect(x,y,8,8);
              }
          }
          const id = ctx.getImageData(0,0,size,size);
          for(let i=0; i<id.data.length; i+=4) {
              id.data[i] = Math.min(255, id.data[i] + Math.random() * 50);
              id.data[i+1] = Math.min(255, id.data[i+1] + Math.random() * 50);
              id.data[i+2] = Math.min(255, id.data[i+2] + Math.random() * 50);
          }
          ctx.putImageData(id, 0, 0);
      }
      return createTextureFromImage(device, canvas);
  };

  useImperativeHandle(ref, () => ({
    capture: (quality = 1) => {
      capturePendingRef.current = quality;
    },
    loadTexture: async (file: File) => {
        if (!deviceRef.current || !file) return;
        try {
            const bitmap = await createImageBitmap(file);
            const texture = await createTextureFromImage(deviceRef.current, bitmap);
            textureRef.current = texture;
            rebind(deviceRef.current);
        } catch (e) {
            console.error("Failed to load texture", e);
        }
    },
    toggleAudio: async () => {
        if (audioContextRef.current) {
            audioContextRef.current.suspend();
            audioContextRef.current = null;
            return;
        }
        
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const ctx = new AudioContext();
            const source = ctx.createMediaStreamSource(stream);
            const analyzer = ctx.createAnalyser();
            analyzer.fftSize = 256;
            source.connect(analyzer);
            
            audioContextRef.current = ctx;
            analyzerRef.current = analyzer;
            audioDataArrayRef.current = new Uint8Array(analyzer.frequencyBinCount);
        } catch (e) {
            console.error("Audio init failed", e);
            alert("Could not access microphone.");
        }
    },
    startVideo: (config: VideoConfig) => {
        if (!canvasRef.current) return;
        recordingConfigRef.current = config;
        chunksRef.current = [];
        recordedFramesRef.current = 0;
        canvasRef.current.width = 1920;
        canvasRef.current.height = 1080;

        const stream = canvasRef.current.captureStream(0);
        const track = stream.getVideoTracks()[0];
        if (track && (track as any).requestFrame) {
             streamTrackRef.current = track;
        } else {
             const autoStream = canvasRef.current.captureStream(config.fps);
             recorderRef.current = new MediaRecorder(autoStream, { mimeType: 'video/webm' });
             streamTrackRef.current = null;
        }

        let mimeType = 'video/webm;codecs=vp9';
        if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'video/webm;codecs=vp8';

        if (!recorderRef.current) {
            const recorder = new MediaRecorder(stream, {
                mimeType,
                videoBitsPerSecond: config.bitrate * 1000000
            });
            recorderRef.current = recorder;
        }

        const recorder = recorderRef.current!;
        recorder.ondataavailable = (e) => {
            if (e.data.size > 0) chunksRef.current.push(e.data);
        };
        recorder.onstop = () => {
            const blob = new Blob(chunksRef.current, { type: 'video/webm' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `cinematic_recording_${Date.now()}.webm`;
            a.click();
            URL.revokeObjectURL(url);
            isRecordingRef.current = false;
            streamTrackRef.current = null;
            onRecordProgress(false, 0);
        };
        recorder.start();
        recordingStartTimeRef.current = performance.now();
        isRecordingRef.current = true;
    },
    stopVideo: () => {
        if (recorderRef.current && recorderRef.current.state === 'recording') {
            recorderRef.current.stop();
        }
    }
  }));

  const rebind = (device: any) => {
      if (!pipelineRef.current || !uniformBufferRef.current || !textureRef.current || !samplerRef.current) return;
      
      const bindGroup = device.createBindGroup({
          layout: pipelineRef.current.getBindGroupLayout(0),
          entries: [
              { binding: 0, resource: { buffer: uniformBufferRef.current } },
              { binding: 1, resource: textureRef.current.createView() },
              { binding: 2, resource: samplerRef.current }
          ]
      });
      bindGroupRef.current = bindGroup;
  };

  const compilePipeline = async (device: any, code: string, context: any) => {
      const format = (navigator as any).gpu.getPreferredCanvasFormat();
      
      const shaderModule = device.createShaderModule({ label: 'Main', code });
      const compilationInfo = await shaderModule.getCompilationInfo();
      if (compilationInfo.messages.length > 0) {
        let hasError = false;
        for (let msg of compilationInfo.messages) {
          if (msg.type === 'error') {
              hasError = true;
              onError({ type: 'compilation', message: getErrorMessage(msg.message), lineNum: msg.lineNum, linePos: msg.linePos });
          }
        }
        if (hasError) return;
      }
      onClearError();
      errorReportedRef.current = false;

      const bindGroupLayout = device.createBindGroupLayout({ 
          entries: [
              // 2 = FRAGMENT. (1=VERTEX, 2=FRAGMENT, 4=COMPUTE)
              // We primarily use these in the Fragment shader.
              { binding: 0, visibility: 2, buffer: { type: 'uniform' }},
              { binding: 1, visibility: 2, texture: {} },
              { binding: 2, visibility: 2, sampler: {} }
          ]
      });

      const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
      
      // Push error scope to catch "Invalid RenderPipeline" issues caused by layout mismatches
      device.pushErrorScope('validation');
      
      const pipeline = device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module: shaderModule, entryPoint: 'vs_main' },
        fragment: { module: shaderModule, entryPoint: 'fs_main', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      });
      
      const error = await device.popErrorScope();
      if (error) {
          console.error("Pipeline Validation Error:", error);
          onError({ type: 'runtime', message: `Pipeline Creation Failed: ${error.message}` });
          pipelineRef.current = null;
          return;
      }

      pipelineRef.current = pipeline;
      rebind(device);
  };

  useEffect(() => {
    isMountedRef.current = true;
    const initWebGPU = async () => {
      const gpu = (navigator as any).gpu;
      if (!gpu) { setIsSupported(false); onError({ type: 'compilation', message: "WebGPU not supported." }); return; }

      try {
        const adapter = await gpu.requestAdapter();
        if (!adapter) { setIsSupported(false); onError({ type: 'compilation', message: "No GPU adapter." }); return; }
        const device = await adapter.requestDevice();
        if (!isMountedRef.current) { device.destroy(); return; }
        deviceRef.current = device;

        device.lost.then((info: any) => { 
            if (isMountedRef.current) onError({ type: 'runtime', message: getErrorMessage(info) }); 
        });
        
        device.addEventListener('uncapturederror', (e: any) => { 
            if (isMountedRef.current && !errorReportedRef.current) {
                console.error("WebGPU Uncaptured Error:", e.error);
                onError({ type: 'runtime', message: `Uncaptured: ${getErrorMessage(e.error)}` }); 
            }
        });

        const canvas = canvasRef.current;
        if (!canvas) return;
        const context = canvas.getContext('webgpu') as any;
        contextRef.current = context;
        const format = gpu.getPreferredCanvasFormat();
        context.configure({ device, format, alphaMode: 'opaque' });

        // 64 (UNIFORM) | 8 (COPY_DST) = 72
        // Total Buffer Size: 512 bytes (Safer alignment & overflow protection)
        const uniformBuffer = device.createBuffer({ size: 512, usage: 72 });
        uniformBufferRef.current = uniformBuffer;

        const defaultTex = await createDefaultTexture(device);
        textureRef.current = defaultTex;
        const sampler = device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            addressModeU: 'repeat',
            addressModeV: 'repeat',
        });
        samplerRef.current = sampler;

        await compilePipeline(device, shaderCode, context);

        requestRef.current = requestAnimationFrame(render);
      } catch (err: any) { onError({ type: 'compilation', message: getErrorMessage(err) }); }
    };
    initWebGPU();
    return () => { isMountedRef.current = false; if (requestRef.current !== null) cancelAnimationFrame(requestRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
      if (deviceRef.current && contextRef.current) {
          compilePipeline(deviceRef.current, shaderCode, contextRef.current);
      }
  }, [shaderCode]);

  const render = async (time: number) => {
    const device = deviceRef.current;
    const context = contextRef.current;
    const pipeline = pipelineRef.current;
    const uniformBuffer = uniformBufferRef.current;
    const bindGroup = bindGroupRef.current;
    const canvas = canvasRef.current;

    // Strict validation
    if (!device || !context || !pipeline || !uniformBuffer || !bindGroup || !canvas || !textureRef.current) {
         requestRef.current = requestAnimationFrame(render);
         return;
    }

    // Stop rendering if a fatal error occurred
    if (errorReportedRef.current) {
        return;
    }

    let width = 0;
    let height = 0;

    if (capturePendingRef.current > 0) {
        width = 3840; height = 2160;
        canvas.width = width; canvas.height = height;
    } else if (isRecordingRef.current) {
        width = 1920; height = 1080;
        if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    } else {
        const dpr = window.devicePixelRatio || 1; 
        width = Math.floor(canvas.clientWidth * dpr);
        height = Math.floor(canvas.clientHeight * dpr);
        if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    }

    if (width <= 0 || height <= 0) {
         requestRef.current = requestAnimationFrame(render);
         return;
    }

    let elapsedTime = (time - startTimeRef.current) * 0.001;
    let cameraTheta = cameraState.current.theta;
    let cameraPhi = cameraState.current.phi;
    let cameraRadius = cameraState.current.radius;
    
    const currentParams = [...paramsRef.current];
    
    // Animation Logic...
    let grainStrength = currentParams.find(p => p.id === 'grainStrength')?.value || 0;
    let aberrationStrength = currentParams.find(p => p.id === 'aberrationStrength')?.value || 0;
    
    if (isRecordingRef.current && recordingConfigRef.current) {
        const fps = recordingConfigRef.current.fps;
        elapsedTime = recordedFramesRef.current / fps;
        recordedFramesRef.current++;
        const duration = recordingConfigRef.current.duration;
        const progress = Math.min(1.0, elapsedTime / duration);
        const remaining = Math.max(0, duration - elapsedTime);
        onRecordProgress(true, remaining);

        const shot = recordingConfigRef.current.shotType;
        if (shot === 'orbit') {
            cameraTheta += elapsedTime * 0.5;
        } else if (shot === 'sweep') {
            cameraTheta += elapsedTime * 0.3; cameraPhi = 0.1; cameraRadius = 6.0;
        } else if (shot === 'dolly') {
            cameraRadius = 6.0 - (progress * 2.0); cameraTheta += elapsedTime * 0.1;
        } else if (shot === 'breathing') {
            cameraRadius = 5.0 + Math.sin(elapsedTime * 0.8) * 0.5; cameraTheta += elapsedTime * 0.2;
        } else if (shot === 'chaos') {
            cameraTheta += elapsedTime * 0.5; cameraPhi = Math.sin(elapsedTime * 2.0) * 0.5; cameraRadius = 4.0 + Math.cos(elapsedTime * 3.0) * 0.5;
        }

        if (recordingConfigRef.current.orchestrate) {
             const azIndex = currentParams.findIndex(p => p.id === 'lightAz');
             if (azIndex !== -1) {
                 const p = { ...currentParams[azIndex] } as any; p.value = (Math.sin(elapsedTime * 0.5) * 0.5 + 0.5); currentParams[azIndex] = p;
             }
        }
        grainStrength = recordingConfigRef.current.postProcess.grain;
        aberrationStrength = recordingConfigRef.current.postProcess.aberration;

        if (elapsedTime >= duration) {
             if (recorderRef.current && recorderRef.current.state === 'recording') recorderRef.current.stop();
        }
    }

    const cx = cameraRadius * Math.cos(cameraPhi) * Math.sin(cameraTheta);
    const cy = cameraRadius * Math.sin(cameraPhi);
    const cz = cameraRadius * Math.cos(cameraPhi) * Math.cos(cameraTheta);
    
    // Total Buffer Size: 512 bytes (128 floats)
    const uniformData = new Float32Array(128); 
    uniformData[0] = width; uniformData[1] = height; uniformData[2] = elapsedTime;
    uniformData[4] = cx; uniformData[5] = cy; uniformData[6] = cz;
    uniformData[8] = mouseState.current.x; uniformData[9] = mouseState.current.y; uniformData[10] = mouseState.current.isDown;
    
    writeParamsToBuffer(uniformData, currentParams, layout);

    // Audio Analysis
    if (audioContextRef.current && analyzerRef.current && audioDataArrayRef.current) {
        analyzerRef.current.getByteFrequencyData(audioDataArrayRef.current);
        const avg = audioDataArrayRef.current.reduce((a, b) => a + b, 0) / audioDataArrayRef.current.length;
        uniformData[32] = avg / 255.0; // Volume
        uniformData[33] = audioDataArrayRef.current[4] / 255.0; // Bass
        uniformData[34] = audioDataArrayRef.current[10] / 255.0; // Mid
        uniformData[35] = audioDataArrayRef.current[20] / 255.0; // High
    }

    device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    // Command Encoding with Diagnostics
    const commandEncoder = device.createCommandEncoder();
    const textureView = context.getCurrentTexture().createView();
    
    const passEncoder = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: textureView,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    
    // We push an error scope HERE to catch validation errors during encoding
    device.pushErrorScope('validation');

    try {
        passEncoder.setPipeline(pipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.draw(6);
        passEncoder.end();
        
        device.queue.submit([commandEncoder.finish()]);
    } catch (e) {
        console.error("Frame failed:", e);
    }

    // Check for validation errors in this frame
    device.popErrorScope().then((error: any) => {
        if (error && !errorReportedRef.current) {
            console.error("WebGPU Validation Failure:", error.message);
            onError({ type: 'runtime', message: `GPU Validation: ${error.message}` });
            errorReportedRef.current = true;
        }
    });

    // Capture handling
    if (capturePendingRef.current > 0) {
        canvas.toBlob((blob) => {
            if (blob) {
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `render_capture_${Date.now()}.png`;
                a.click();
                URL.revokeObjectURL(url);
            }
            capturePendingRef.current = 0;
        });
    }

    if (isRecordingRef.current && streamTrackRef.current) {
        try {
            if (streamTrackRef.current.requestFrame) {
                 streamTrackRef.current.requestFrame();
            }
        } catch(e) { /* ignore */ }
    }

    requestRef.current = requestAnimationFrame(render);
  };

  // --- INTERACTION ---
  const handleMouseDown = (e: React.MouseEvent) => {
      mouseState.current.isDown = 1;
      cameraState.current.isDragging = true;
      cameraState.current.lastX = e.clientX;
      cameraState.current.lastY = e.clientY;
  };
  const handleMouseMove = (e: React.MouseEvent) => {
      mouseState.current.x = e.clientX; mouseState.current.y = e.clientY;
      if (cameraState.current.isDragging) {
          const dx = e.clientX - cameraState.current.lastX;
          const dy = e.clientY - cameraState.current.lastY;
          cameraState.current.theta -= dx * 0.005;
          cameraState.current.phi = Math.max(0.1, Math.min(Math.PI - 0.1, cameraState.current.phi + dy * 0.005));
          cameraState.current.lastX = e.clientX;
          cameraState.current.lastY = e.clientY;
      }
  };
  const handleMouseUp = () => { mouseState.current.isDown = 0; cameraState.current.isDragging = false; };
  const handleWheel = (e: React.WheelEvent) => {
      cameraState.current.radius = Math.max(2.0, Math.min(20.0, cameraState.current.radius + e.deltaY * 0.005));
  };

  return (
    <>
      <div 
        className="relative w-full h-full cursor-crosshair touch-none"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
      >
        {!isSupported && (
            <div className="absolute inset-0 flex items-center justify-center text-red-500 font-mono text-xs">
                WEBGPU_NOT_DETECTED
            </div>
        )}
        <canvas ref={canvasRef} className="block w-full h-full" />
        
        {/* Params Overlay */}
        <ParamsControlPanel params={params} setParams={setParams} description={description} />
      </div>
    </>
  );
});

export default WebGPURenderer;
