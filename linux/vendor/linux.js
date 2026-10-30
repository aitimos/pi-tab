// SPDX-License-Identifier: GPL-2.0-only

/// Create a Linux machine and run it.
export const linux = async (worker_url, variant, vmlinux, boot_cmdline, initrd, log, console_write, bridge, onBridge, onFailure) => {
  const workers = new Set();
  let stopped = false;
  const arch_bits = variant.startsWith("wasm32_") ? 32 : 64;
  const Ulong = (arch_bits == 32) ? Number : BigInt;

  /// Dict of online CPUs.
  const cpus = {};

  /// Dict of tasks.
  const tasks = {};

  /// Input buffer (from keyboard to tty).
  let input_buffer = new ArrayBuffer(0);

  const text_decoder = new TextDecoder("utf-8");
  const text_encoder = new TextEncoder();

  const lock_notify = (locks, lock, count) => {
    Atomics.store(locks._memory, locks[lock], 1);
    Atomics.notify(locks._memory, locks[lock], count || 1);
  };

  const lock_wait = (locks, lock) => {
    Atomics.wait(locks._memory, locks[lock], 0);
    Atomics.store(locks._memory, locks[lock], 0);
  };

  /// Callbacks from Web Workers (each one representing one task).
  const message_callbacks = {
    bridge: message => {
      try { onBridge(message); }
      finally { Atomics.store(message.ack, 0, 1); Atomics.notify(message.ack, 0); }
    },
    crash: message => onFailure(new Error(message.message)),
    start_primary: (message) => {
      // CPU 0 has init_task which sits in static storage. After booting it becomes CPU 0's idle task. The runner will
      // in this special case tell us where it is so that we can register it.
      log("Starting cpu 0 with init_task " + message.init_task)
      tasks[message.init_task] = cpus[0];
    },

    start_secondary: (message) => {
      if (message.cpu <= 0) {
        throw new Error("Trying to start secondary cpu with ID <= 0");
      }

      log("Starting cpu " + message.cpu + " (" + message.idle_task + ")");
      make_cpu(message.cpu, message.idle_task);
    },

    stop_secondary: (message) => {
      if (message.cpu <= 0) {
        // If you arrive here, you probably got panic():ed with a broken stack.
        onFailure(new Error('Linux CPU 0 stopped unexpectedly'));
        return;
      }

      if (cpus[message.cpu]) {
        log("[Main]: Stopping CPU " + message.cpu);
        cpus[message.cpu].worker.terminate();
        workers.delete(cpus[message.cpu].worker);
        delete cpus[message.cpu];
      } else {
        log("[Main]: Tried to stop CPU " + message.cpu + " but it was already stopped (broken system)!");
      }
    },

    create_and_run_task: (message) => {
      // ret_from_fork will make sure the task switch finishes.
      make_task(message.prev_task, message.new_task, message.name, message.user_executable);
    },

    release_task: (message) => {
      kill_task(message.dead_task);
    },

    serialize_tasks: (message) => {
      // next_task was previously suspended, wake it up.

      // Tell the next task where we switched from, so that it can finish the task switch.
      tasks[message.next_task].last_task[0] = message.prev_task;

      tasks[message.prev_task].running = false;
      tasks[message.next_task].running = true;

      // Release the above write of last_task and wake up the task.
      lock_notify(tasks[message.next_task].locks, "serialize");

      // In case the task was dying, we're now done. prev_task will wait in serialize_me() but never be scheduled again.
      if (tasks[message.prev_task].kill) {
        kill_task(message.prev_task);
      }
    },

    console_read: (message, worker) => {
      const memory_u8 = new Uint8Array(memory.buffer);
      const buffer = new Uint8Array(input_buffer);

      const used = buffer.slice(0, message.count);
      memory_u8.set(used, message.buffer);

      const unused = buffer.slice(message.count);
      input_buffer = unused.buffer;

      // Tell the Worker that asked for input how many bytes (perhaps 0) were actually written.
      Atomics.store(message.console_read_messenger, 0, used.length);
      Atomics.notify(message.console_read_messenger, 0, 1);
    },

    console_write: (message) => {
      console_write(message.message);
    },

    log: (message) => {
      log(message.message);
    },
  };

  /// Memory shared between all CPUs.
  const memory = new WebAssembly.Memory({
    initial: Ulong(30), // TODO: extract this automatically from vmlinux.
    maximum: Ulong(0x10000), // Allow the full 32-bit address space to be allocated.
    shared: true,
    address: 'i' + arch_bits,
  });

  /**
   * Create and run one CPU in a background thread (a Web Worker).
   *
   * This will run boot code for the CPU, and then drop to run the idle task. For CPU 0 this involves booting the entire
   * system, including bringing up secondary CPUs at the end, while for secondary CPUs, this just means some
   * book-keeping before dropping into their own idle tasks.
   */
  const make_cpu = (cpu, idle_task) => {
    const options = {
      runner_type: (cpu == 0) ? "primary_cpu" : "secondary_cpu",
      idle_task: idle_task,
    };

    if (cpu == 0) {
      options.boot_cmdline = boot_cmdline;
      options.initrd = initrd;
      initrd = null;  // allow gc
    }

    // idle_task is undefined for cpu 0, we will know it first when start_primary notifies us.
    const name = "CPU " + cpu + " [boot+idle]" + (cpu != 0 ? " (" + idle_task + ")" : "");

    const runner = make_vmlinux_runner(name, options);
    cpus[cpu] = runner;
    if (cpu != 0) {
      tasks[idle_task] = runner; // For CPU 0, start_primary does this registration for us.
    }
  };

  /**
   * Create and run one task. This task has been switch_to():ed by the scheduler for the first time.
   *
   * In the beginning, all tasks are serialized and have to cooperate to schedule eachother, but after secondary CPUs
   * are brought up, they can run concurrently (and will effectively be managed by the Wasm host OS). While we are not
   * able to suspend them from JS, the host OS will do that.
   */
  const make_task = (prev_task, new_task, name, user_executable) => {
    const options = {
      runner_type: "task",
      prev_task: prev_task,
      new_task: new_task,
      user_executable: user_executable,
    };
    tasks[new_task] = make_vmlinux_runner(name + " (" + new_task + ")", options);
  };

  const kill_task = (dead_task) => {
    const task = tasks[dead_task];
    if (task.running) {
      // Case 1: current task is killing itself => we know that the reaped task is currently running (probably kthread).
      //
      // We need to delay killing the worker as it's still running. There is still some code for it to run, and
      // importantly, it needs to notify the next task to run on the CPU in serialize_me(). If the worker was
      // terminated before it was scheduled out, the dead task could deadlock its CPU on tasks[???].locks["serialize"].
      task.kill = true;
    } else {
      // Case 2: current task reaped another task => we know that the reaped task is not running. (kill == false).
      // Case 3: we get here from Case 1 as it eventually scheduled out, calling serialize_me(). (kill == true).
      task.worker.terminate();
      workers.delete(task.worker);
      delete tasks[dead_task];
    }
  };

  /// Create a runner for vmlinux. It will run in a Web Worker and execute some specified code.
  const make_vmlinux_runner = (name, options) => {
    // Note: SharedWorker does not seem to allow WebAssembly Module or Memory instances posted.
    if (stopped) throw new Error("Linux instance has stopped");
    const worker = new Worker(worker_url, { name: name });
    workers.add(worker);

    let locks = {
      serialize: 0,
    };
    locks._memory = new Int32Array(new SharedArrayBuffer(Object.keys(locks).length * 4));

    // Store for last task when wasm_serialize() returns in switch_to(). Needed for each task, both normal ones and each
    // CPUs idle tasks (first called init_task (PID 0), not to be confused with init (PID 1) which is a normal task).
    const last_task = new Uint32Array(new SharedArrayBuffer(4));

    worker.onerror = (error) => {
      onFailure(new Error(error.message || "Linux worker failed"));
    };

    worker.onmessage = (message_event) => {
      const data = message_event.data;
      if (!stopped) message_callbacks[data.method](data, worker);
    };

    worker.onmessageerror = (error) => {
      onFailure(new Error(error.message || "Linux worker failed"));
    };

    worker.postMessage({
      ...options,
      method: "init",
      variant: variant,
      bridge: bridge,
      vmlinux: vmlinux,
      memory: memory,
      locks: locks,
      last_task: last_task,
      runner_name: name,
    });

    return {
      worker: worker,
      locks: locks,
      last_task: last_task,
      running: true,
      kill: false,
    };
  };

  // Create the primary cpu, it will later on callback to us and we start secondaries.
  make_cpu(0);

  return {
    dispose: () => { stopped = true; for (const worker of workers) worker.terminate(); workers.clear(); },
    key_input: (data) => {
      const key_buffer = text_encoder.encode(data);  // Possibly UTF-8 (up to 16 bits).

      // Append key_buffer to the end of input_buffer.
      const old_size = input_buffer.byteLength;
      const next = new Uint8Array(old_size + key_buffer.byteLength);
      next.set(new Uint8Array(input_buffer));
      input_buffer = next.buffer;
      (new Uint8Array(input_buffer)).set(key_buffer, old_size);
    }
  };
};
