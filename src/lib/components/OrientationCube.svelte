<!--
  OrientationCube
  ===============
  A small Three.js scene that mirrors the device's current orientation in
  real time. Shaped like an iPhone (1 × 2 × 0.1 box) so the visual mapping
  is intuitive: when the user tilts the phone forward, the on-screen
  rectangle tilts forward; when they rotate counter-clockwise from above,
  the rectangle yaws to follow.

  Coordinate mapping (iOS deviceorientation → Three.js Euler):

    alpha (deg, compass)            → Y axis (yaw)
    beta  (deg, front/back tilt)    → X axis (pitch)
    gamma (deg, left/right tilt)    → Z axis (roll, sign-inverted)

  Applied in YXZ order, which gives the most natural "follow the phone"
  feel without obvious gimbal-lock at common attitudes.

  Three.js is dynamic-imported on mount so it's NOT in the initial bundle:
  users who never toggle the cube on never pay for the ~600 KB three.js
  download.

  The renderer is destroyed and all GPU buffers disposed on unmount, so
  toggling the cube off in Settings reclaims memory immediately.
-->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';

  interface Props {
    /** Compass heading in degrees (0 = north). */
    alpha: number;
    /** Front/back tilt in degrees (positive = tilted toward the user). */
    beta: number;
    /** Left/right tilt in degrees (positive = right side down). */
    gamma: number;
  }
  let { alpha, beta, gamma }: Props = $props();

  let container: HTMLDivElement;
  /** Cleanup callback registered after the async mount completes. */
  let cleanup: (() => void) | null = null;
  /**
   * Function to apply a new pose to the cube. Captured by the async mount
   * and called both inside the RAF loop and from the $effect on prop changes.
   */
  let updatePose: ((a: number, b: number, g: number) => void) | null = null;

  onMount(async () => {
    // Dynamic import keeps three.js out of the initial bundle.
    const THREE = await import('three');

    // ---- Scene + camera ------------------------------------------------
    const scene = new THREE.Scene();
    const w0 = container.clientWidth;
    const h0 = container.clientHeight;
    const camera = new THREE.PerspectiveCamera(40, w0 / h0, 0.1, 100);
    camera.position.set(2.2, 1.8, 3.6);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(w0, h0);
    // Cap DPR at 2 — beyond that GPU cost grows with no visible benefit
    // for a tiny cube viewport.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    // ---- Phone-shaped block --------------------------------------------
    // Dimensions chosen to look unmistakably iPhone-ish: 1 wide × 2 tall ×
    // 0.1 thick. The "screen" face is the +Z face (front of the device).
    const geo = new THREE.BoxGeometry(1, 2, 0.1);

    // Per-face materials, using the iOS system color palette so the
    // colors match the rest of the app. Face index order in BoxGeometry:
    //   0: +X (right)   1: -X (left)
    //   2: +Y (top)     3: -Y (bottom)
    //   4: +Z (front)   5: -Z (back)
    const faceColors = [
      0xff3b30, // right  — systemRed
      0x34c759, // left   — systemGreen
      0x007aff, // top    — systemBlue
      0xff9500, // bottom — systemOrange
      0x111111, // front  — near-black (the "screen")
      0x8e8e93  // back   — systemGray
    ];
    const materials = faceColors.map((c) =>
      new THREE.MeshLambertMaterial({ color: c })
    );
    const phone = new THREE.Mesh(geo, materials);
    scene.add(phone);

    // Thin black wireframe edges for definition
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: 0x000000 })
    );
    phone.add(edges);

    // ---- Lights --------------------------------------------------------
    // Ambient fills the dark side; a single directional light gives the
    // primary shape readout. No shadows — overkill for a UI thumbnail.
    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    const dir = new THREE.DirectionalLight(0xffffff, 0.85);
    dir.position.set(2, 4, 3);
    scene.add(ambient, dir);

    // ---- World-frame axis helper --------------------------------------
    // Small RGB axes at the origin so the user has a reference frame.
    // Red = X (east), green = Y (up), blue = Z (toward camera). Scaled
    // smaller than the phone so it doesn't overpower the main object.
    const axes = new THREE.AxesHelper(0.6);
    (axes.material as THREE.LineBasicMaterial).depthTest = false;
    axes.renderOrder = 1;
    scene.add(axes);

    // ---- Pose update ---------------------------------------------------
    /**
     * Apply device orientation (in degrees) to the phone mesh.
     * `gamma` is sign-inverted because iOS reports a positive value when
     * the right edge tips down, but our Three.js roll convention treats
     * counter-clockwise (viewed from +Z) as positive.
     */
    updatePose = (a: number, b: number, g: number) => {
      const eu = new THREE.Euler(
        THREE.MathUtils.degToRad(b),
        THREE.MathUtils.degToRad(a),
        THREE.MathUtils.degToRad(-g),
        'YXZ'
      );
      phone.quaternion.setFromEuler(eu);
    };
    updatePose(alpha, beta, gamma);

    // ---- Resize handling ----------------------------------------------
    const ro = new ResizeObserver(() => {
      const w = container.clientWidth, h = container.clientHeight;
      if (w === 0 || h === 0) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    ro.observe(container);

    // ---- RAF render loop ----------------------------------------------
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      renderer.render(scene, camera);
    };
    loop();

    // ---- Cleanup -------------------------------------------------------
    // Dispose every GPU resource we allocated. Important: hot-toggling the
    // cube off in Settings should fully reclaim the WebGL context so we
    // don't accumulate dead contexts across sessions.
    cleanup = () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      geo.dispose();
      materials.forEach((m) => m.dispose());
      (edges.geometry as THREE.BufferGeometry).dispose();
      (edges.material as THREE.LineBasicMaterial).dispose();
      (axes.geometry as THREE.BufferGeometry).dispose();
      (axes.material as THREE.LineBasicMaterial).dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
  });

  onDestroy(() => cleanup?.());

  // Re-apply pose whenever the parent updates orientation props
  $effect(() => {
    updatePose?.(alpha, beta, gamma);
  });
</script>

<div bind:this={container} class="cube-host" aria-label="3D device orientation"></div>

<style>
  .cube-host {
    width: 100%;
    height: 200px;
    border-radius: var(--r-card);
    background: linear-gradient(180deg, var(--bg-elev-2) 0%, var(--bg-elev) 100%);
    overflow: hidden;
  }
</style>
