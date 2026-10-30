// SPDX-License-Identifier: GPL-2.0-only

(function (console) {
  let port = self;
  let variant;
  let bridge_control, bridge_data;
  const bridge_ack = new Int32Array(new SharedArrayBuffer(4));
  let arch_bits;
  let Ulong;
  let memory = null;  // Note: memory.buffer has to be re-accessed after growing the memory!
  let locks = null;
  const text_decoder = new TextDecoder("utf-8");
  const text_encoder = new TextEncoder();

  /// A string denoting the runner name (same as Worker name), useful for debugging.
  let runner_name = "[Unknown]";

  /// SAB-backed storage for last process in switch_to (when it returns back from another task).
  let switch_to_last_task = null;

  /// The vmlinux instance, to handle boot, idle, kthreads and syscalls etc.
  let vmlinux_instance = null;

  /// The user executable (if any) to run when we're not in vmlinux.
  let user_executable = null;
  let user_executable_params = null;

  /// The user executabe instance, or null. Try using the instance variable in the promise over this one if possible.
  let user_executable_instance = null;
  let user_executable_imports = null;

  /// Flag that a clone callback should be called instead of _start().
  let should_call_clone_callback = false;

  /// A messenger to synchronize with the main thread, as well as communicate how many bytes were read on the console.
  let console_read_messenger = new Int32Array(new SharedArrayBuffer(4));

  /// An exception type used to abort part of execution (useful for collapsing the call stack of user code).
  class Trap extends Error {
    constructor(kind) {
      super("This exception should be ignored. It is part of Linux/Wasm host glue.");
      Error.captureStackTrace && Error.captureStackTrace(this, Trap);
      this.name = "Trap";
      this.kind = kind;
    }
  }

  const log = (message) => {
    port.postMessage({
      method: "log",
      message: "[Runner " + runner_name + "]: " + message,
    });
  };

  /// Get a JS string object from a (nul-terminated) C-string in a Uint8Array.
  const get_cstring = (memory, index) => {
    const memory_u8 = new Uint8Array(memory.buffer);
    let end;
    for (end = index; memory_u8[end]; ++end); // Find terminating nul-character.
    return text_decoder.decode(memory_u8.slice(index, end));
  };

  const lock_notify = (lock, count) => {
    Atomics.store(locks._memory, locks[lock], 1);
    Atomics.notify(locks._memory, locks[lock], count || 1);
  };

  const lock_wait = (lock) => {
    Atomics.wait(locks._memory, locks[lock], 0);
    Atomics.store(locks._memory, locks[lock], 0);
  };

  const serialize_me = () => {
    // Wait for some other task or CPU to wake us up.
    lock_wait("serialize");
    return switch_to_last_task[0];  // last_task was written by the caller just prior to waking.
  };

  /// Callbacks from within Linux/Wasm out to our host code (cpu is not neccessarily ours).
  const host_callbacks = {
    pi_receive: (buffer, capacity) => {
      const size = Atomics.load(bridge_control, 0);
      if (!size) return 0;
      if (size > capacity) throw new Error("Linux bridge packet exceeds capacity");
      new Uint8Array(memory.buffer).set(bridge_data.subarray(0, size), buffer);
      Atomics.store(bridge_control, 0, 0);
      return size;
    },
    pi_cancelled: id => Atomics.load(bridge_control, 1) === id ? 1 : 0,
    pi_reply: (id, kind, buffer, length, status) => {
      const data = new Uint8Array(memory.buffer).slice(buffer, buffer + length);
      Atomics.store(bridge_ack, 0, 0);
      port.postMessage({ method: "bridge", id, kind, data, status, ack: bridge_ack }, [data.buffer]);
      Atomics.wait(bridge_ack, 0, 0);
    },
    /// Start secondary CPU.
    wasm_start_cpu: (cpu, idle_task) => {
      // New web workers cannot be spawned from within a Worker in most browsers. It can currently not be spawned from
      // within a SharedWorker in any browser. Do it on the main thread instead.
      port.postMessage({ method: "start_secondary", cpu: cpu, idle_task: idle_task });
    },

    /// Stop secondary CPU (rather abruptly).
    wasm_stop_cpu: (cpu) => {
      port.postMessage({ method: "stop_secondary", cpu: cpu });
    },

    /// Creation of tasks on our end. Runs them too.
    wasm_create_and_run_task: (prev_task, new_task, name, bin_start, bin_end, data_start, table_start) => {
      // Tell main to create the new task, and then run it for the first time!
      port.postMessage({
        method: "create_and_run_task",
        prev_task: prev_task,
        new_task: new_task,
        name: get_cstring(memory, name),

        // For user tasks, there is user code to load first before trying to run it.
        user_executable: bin_start ? {
          bin_start: bin_start,
          bin_end: bin_end,
          data_start: data_start,
          table_start: table_start,
        } : null,
      });

      // Serialize this (old) task.
      return serialize_me();
    },

    /// Remove a task created by wasm_create_and_run_task().
    wasm_release_task: (dead_task) => {
      port.postMessage({
        method: "release_task",
        dead_task: dead_task,
      });
    },

    /// Serialization of tasks (idle tasks and before SMP is started).
    wasm_serialize_tasks: (prev_task, next_task) => {
      // Notify the next task that it can run again.
      port.postMessage({
        method: "serialize_tasks",
        prev_task: prev_task,
        next_task: next_task,
      });

      // Serialize this (old) task.
      return serialize_me();
    },

    /// Kernel panic. We can't proceed.
    wasm_panic: (msg) => {
      const message = "Kernel panic: " + get_cstring(memory, msg);
      port.postMessage({method: "crash", message});
      console.error(message);
      log(message);

      // This will stop execution of the current task.
      throw new Trap("panic");
    },

    /// Dump a stack trace into a text buffer. (The exact format is implementation-defined and varies by browser.)
    wasm_dump_stacktrace: (stack_trace, max_size) => {
      try {
        throw new Error();
      } catch (error) {
        const memory_u8 = new Uint8Array(memory.buffer);
        const encoded = text_encoder.encode(error.stack).slice(0, max_size - 1);
        memory_u8.set(encoded, stack_trace);
        memory_u8[stack_trace + encoded.length] = 0;
      }
    },

    /// Replace the currently executing image (kthread spawning init, or user process) with a new user process image.
    wasm_load_executable: (bin_start, bin_end, data_start, table_start) => {
      user_executable = WebAssembly.compile(new Uint8Array(memory.buffer).slice(bin_start, bin_end));
      user_executable_params = {
        data_start: data_start,
        table_start: table_start,
      };

      // We release our reference already, just to be sure. The promise chain will still have a reference until the
      // kernel exits back to userland, which will termintate the user executable with a Trap.
      user_executable_instance = null;
      user_executable_imports = null;
    },

    /// Handle user mode return (e.g. from syscall) that should not proceed normally. (Not called on normal returns.)
    wasm_user_mode_tail: (flow) => {
      if (flow == -1) {
        // Exec has been called and we should not return from the syscall. Trap() to collapse the call stack of the user
        // executable. When swallowed, run the new user executable that was already preloaded by wasm_load_executable().
        // This takes precedence of signal handlers or signal return - no reason to run any old user code!
        throw new Trap("reload_program");
      } else if (flow >= 1 && flow <= 3) {
        // First, handle any signal (possibly stacked). Then, handle any signal return (happens after stacked signals).
        // If exec() happens, we will slip out in the catch-else clause, ensuring the sigreturn does not proceed.
        if (flow & 1) {
          try {
            if (user_executable_instance.exports.__libc_handle_signal) {
              // Setup signal frame...
              user_executable_imports.env.__stack_pointer.value = vmlinux_instance.exports.get_user_stack_pointer();
              user_executable_instance.exports.__set_tls_base(vmlinux_instance.exports.get_user_tls_base());

              user_executable_instance.exports.__libc_handle_signal();
              throw new Error("Wasm function __libc_handle_signal() returned (it should never return)!");
            } else {
              throw new Error("Wasm function __libc_handle_signal() not defined!");
            }
          } catch (error) {
            if (error instanceof Trap && error.kind == "signal_return") {
              // ...restore signal frame.
              user_executable_imports.env.__stack_pointer.value = vmlinux_instance.exports.get_user_stack_pointer();
              user_executable_instance.exports.__set_tls_base(vmlinux_instance.exports.get_user_tls_base());
            } else {
              // Either a genuine error, or a Trap() from exec() (signal handlers are allowed to call exec()).
              throw error;
            }
          }
        }

        if (flow & 2) {
          throw new Trap("signal_return");
        }
      } else {
        throw new Error("wasm_syscall_tail called with unknown kind");
      }
    },

    // After this line follows host callbacks used by various drivers. In the future, we may make drivers more
    // modularized and allow them to allocate certain resources, like host callbacks, IRQ numbers, even syscalls...

    // Host callbacks by the Wasm-default clocksource.

    wasm_cpu_clock_get_monotonic: () => {
      // Convert this double in ms to u64 in us.
      // Modern browsers can on good days reach 5us accuracy, given that the platform supports it.
      return BigInt(Math.round(1000 * (performance.timeOrigin + performance.now()))) * 1000n;
    },

    // Host callbacks by the Wasm-default random number generator.
    wasm_random_get_bytes: (buffer, count) => {
      if (count > 0x10000) {
        return -1;
      }

      const data = new Uint8Array(count);
      crypto.getRandomValues(data);
      new Uint8Array(memory.buffer).set(data, buffer);

      return count;
    },

    // Host callbacks used by the Wasm-default console driver.

    wasm_driver_hvc_put: (buffer, count) => {
      const memory_u8 = new Uint8Array(memory.buffer);

      port.postMessage({
        method: "console_write",
        message: text_decoder.decode(memory_u8.slice(buffer, buffer + count)),
      });

      return count;
    },

    wasm_driver_hvc_get: (buffer, count) => {
      // Reset lock. Using .store() for the memory barrier.
      Atomics.store(console_read_messenger, 0, -1);

      // Tell the main thread to write any input into memory, up to count bytes.
      port.postMessage({
        method: "console_read",
        buffer: buffer,
        count: count,
        console_read_messenger: console_read_messenger,
      });

      // Wait for a response from the main thread about how many bytes were actually written, could be 0.
      Atomics.wait(console_read_messenger, 0, -1);
      let console_read_count = Atomics.load(console_read_messenger, 0);
      return console_read_count;
    },
  };

  /// Callbacks from the main thread.
  const message_callbacks = {
    init: (message) => {
      bridge_control = new Int32Array(message.bridge, 0, 2);
      bridge_data = new Uint8Array(message.bridge, 8);
      variant = message.variant;
      arch_bits = variant.startsWith("wasm32_") ? 32 : 64;
      Ulong = (arch_bits == 32) ? Number : BigInt;

      if (arch_bits == 64) {
        // Quick hack that truncates parameters to 32-bit Number, then upsamples them to BigInt. Ugly but works in practice for memories <4G.
        for (const method in host_callbacks) {
          const original = host_callbacks[method];
          host_callbacks[method] = function (...args) {
            const result = original(...args.map(Number));
            if (typeof result !== "undefined") {
              return BigInt(result);
            }
          };
        }
      }

      runner_name = message.runner_name;
      memory = message.memory;
      locks = message.locks;
      switch_to_last_task = message.last_task; // Only defined for tasks and CPU 0 (init task).

      if (message.user_executable) {
        // We are in a new runner that should duplicate the user executable. Happens when someone calls clone().
        host_callbacks.wasm_load_executable(
          message.user_executable.bin_start,
          message.user_executable.bin_end,
          message.user_executable.data_start,
          message.user_executable.table_start);
      }

      let import_object = {
        env: {
          ...host_callbacks,
          memory: message.memory,
        },
      };

      // This is a global error handler that is used when calling Wasm code.
      const wasm_error = (error) => {
        port.postMessage({method: "crash", message: "Wasm crash: " + error.stack});
        log("Wasm crash: " + error.stack);
        console.error(error);

        if (vmlinux_instance) {
          vmlinux_instance.exports.raise_exception();
          throw new Error("raise_exception() returned");
        } else {
          // Only log stack if vmlinux is not up already - it will dump stacks itself.
          log(error.stack);
          throw error;
        }
      };

      const vmlinux_setup = () => {
        // Instantiate a vmlinux Wasm Module. This will implicitly run __wasm_init_memory, which will effectively:
        // * Copy all passive data segments into their (static) position.
        // * Clear BSS (in its static position).
        // * Drop all passive data segments.
        // An in-memory atomic flag ensures this only happens the first time vmlinux is instantiated on the main memory.
        return WebAssembly.instantiate(message.vmlinux, import_object).then((instance) => {
          vmlinux_instance = instance;
        });
      };

      const vmlinux_run = () => {
        if (message.runner_type == "primary_cpu") {
          // Notify the main thread about init task so that it knows where it resides in memory.
          port.postMessage({
            method: "start_primary",
            init_task: vmlinux_instance.exports.init_task.value,
          });

          // Setup the boot command line. We have the luxury to be able to write to it directly. The maximum length is
          // not set here but is set by COMMAND_LINE_SIZE (defaults to 512 bytes).
          const cmdline = message.boot_cmdline + "\0";
          const cmdline_buffer = Number(vmlinux_instance.exports.boot_command_line.value);
          new Uint8Array(memory.buffer).set(text_encoder.encode(cmdline), cmdline_buffer);

          // Grow the memory to fit initrd and copy it.
          //
          // All typed arrays and views on memory.buffer become invalid by growing and need to be re-created. grow()
          // will return the old size, which becomes our base address for initrd.
          if (arch_bits == 64) {
            const initrd_start = memory.grow(BigInt(((message.initrd.byteLength + 0xFFFF) / 0x10000) | 0)) * 0x10000n;
            const initrd_end = initrd_start + BigInt(message.initrd.byteLength);
            new Uint8Array(memory.buffer).set(new Uint8Array(message.initrd), Number(initrd_start));
            new DataView(memory.buffer).setBigUint64(Number(vmlinux_instance.exports.initrd_start.value), initrd_start, true);
            new DataView(memory.buffer).setBigUint64(Number(vmlinux_instance.exports.initrd_end.value), initrd_end, true);
          } else {
            const initrd_start = memory.grow(((message.initrd.byteLength + 0xFFFF) / 0x10000) | 0) * 0x10000;
            const initrd_end = initrd_start + message.initrd.byteLength;
            new Uint8Array(memory.buffer).set(new Uint8Array(message.initrd), initrd_start);
            new DataView(memory.buffer).setUint32(vmlinux_instance.exports.initrd_start.value, initrd_start, true);
            new DataView(memory.buffer).setUint32(vmlinux_instance.exports.initrd_end.value, initrd_end, true);
          }

          // This will boot the maching on the primary CPU. Later on, it will boot secondaries...
          //
          // _start sets up the Wasm global __stack_pointer to init_stack and calls start_kernel(). Note that this will
          // grow the memory and thus all views on memory.buffer become invalid.
          vmlinux_instance.exports._start();

          // _start() will never return, unless it fails to allocate all memoy it wants to.
          throw new Error("_start did not even succeed in allocating 16 pages of RAM, aborting...");
        } else if (message.runner_type == "secondary_cpu") {
          // start_secondary() will never return. It can be killed by terminate() on this Worker.
          vmlinux_instance.exports._start_secondary(Ulong(message.idle_task));

          throw new Error("start_secondary returned");
        } else if (message.runner_type == "task") {
          // A fresh task, possibly serialized on CPU 0 before secondaries are brought up.
          should_call_clone_callback = vmlinux_instance.exports.ret_from_fork(Ulong(message.prev_task), Ulong(message.new_task));

          // Two cases exist when we reach here:
          // 1. The kthread that spawned init retuned.
          // The code will already have been loaded, just execute it.
          //
          // 2. Someone called clone.
          // We should call the clone callback on the user executable, which has already been loaded.
          //
          // Notably, we don't end up here after exec() syscalls. Instead, the user instance is reloaded directly.
          return;
        } else {
          throw new Error("Unknown runner_type: " + message.runner_type);
        }
      };

      const user_executable_setup = () => {
        const stack_pointer = vmlinux_instance.exports.get_user_stack_pointer();
        const tls_base = vmlinux_instance.exports.get_user_tls_base();

        user_executable_imports = {
          env: {
            memory: memory,
            pi_receive: host_callbacks.pi_receive,
            pi_reply: host_callbacks.pi_reply,
            pi_cancelled: host_callbacks.pi_cancelled,
            __memory_base: new WebAssembly.Global({ value: 'i' + arch_bits, mutable: false }, Ulong(user_executable_params.data_start)),
            __stack_pointer: new WebAssembly.Global({ value: 'i' + arch_bits, mutable: true }, stack_pointer),
            __indirect_function_table: new WebAssembly.Table({ initial: 4096, element: "anyfunc" }), // TODO: fix this!
            __table_base: new WebAssembly.Global({ value: 'i' + arch_bits, mutable: false }, Ulong(user_executable_params.table_start)),
            __table_base32: new WebAssembly.Global({ value: 'i32', mutable: false }, Number(user_executable_params.table_start)),

            // To be correct, we should save AND restore these globals between the user instance and vmlinux instance:
            // __stack_pointer <-> __user_stack_pointer
            // __tls_base <-> __user_tls_base
            // The kernel interacts with them in the following ways:
            // * Diagnostics (reading them and displaying them in informational messages).
            // * ret_from_fork: writes stack and tls. We have to deal with it, but not here, as this is not a syscall!
            // * syscall exec: tls should be kept even if the process image is replaced (probably has no real use case).
            // * syscall clone: stack and tls should be transfered to the new instance, unless overridden.
            // * signal handlers: also not a syscall - vmlinux calls the host, perhaps during syscall return!
            // The kernel never modifies neither of them for the task that makes a syscall.
            //
            // To make syscalls faster (allowing them to not go through a slow JavaScript wrapper), we skip transferring
            // them back to the user instance. They always have to be transferred to vmlinux at syscall sites, as a
            // signal being handled in its return path would need to save (and restore) them on its signal stack.
            __wasm_syscall_0: vmlinux_instance.exports.wasm_syscall_0,
            __wasm_syscall_1: vmlinux_instance.exports.wasm_syscall_1,
            __wasm_syscall_2: vmlinux_instance.exports.wasm_syscall_2,
            __wasm_syscall_3: vmlinux_instance.exports.wasm_syscall_3,
            __wasm_syscall_4: vmlinux_instance.exports.wasm_syscall_4,
            __wasm_syscall_5: vmlinux_instance.exports.wasm_syscall_5,
            __wasm_syscall_6: vmlinux_instance.exports.wasm_syscall_6,

            __wasm_abort: () => {
              debugger
              throw WebAssembly.RuntimeError('abort');
            },
          },
        };

        // Instantiate a user Wasm Module. This will implicitly run __wasm_init_memory, which will effectively:
        // * Initialize the TLS pointer (to a data_start-relocated static area, for the first thread).
        // * Copy all passive data segments into their (data_start-relocated) position.
        // * Clear BSS (data_start-relocated).
        // * Drop all passive data segments (except the TLS region, which is saved, but unused in the musl case).
        // An atomic flag ensures this only happens for the first thread to be started (using instantiate).
        //
        // The TLS pointer will be initialized in the following way ways:
        // * kthread-returns-to-init: __user_tls_base would be 0 as it's zero-initialized on the kthreads switch_stack.
        //   (We are ignoring it.) __wasm_init_memory() would initialize it to the static area as described above.
        //
        // * exec: __user_tls_base should have been the value of the process calling exec (during the syscall). However,
        //   we would want to restore it as part of initializing the runtime, which is exactly what __wasm_init_memory()
        //   does. This also means that whatever value the task calling exec() supplied for tls is ignored.
        //
        // * clone: clone explicitly passes its tls pointer to the kernel as part of the syscall. Unless the tls pointer
        //   has been overridden with CLONE_SETTLS, it will be copied from the old task to the new one. This is mostly
        //   useful when CLONE_VFORK is used, in which case the new task can borrow the TLS until it calls exec or exit.
        let woken = user_executable.then((user_module) => WebAssembly.instantiate(user_module, user_executable_imports));

        woken = woken.then((instance) => {
          instance.exports.__wasm_apply_data_relocs();
          if (should_call_clone_callback) {
            // Note: __wasm_init_tls cannot be used as it would also re-initilize the _Thread_local variables' data. But
            // on a clone(), it is none of our business to do that. It's up to the libc to do that as part of pthreads.
            // Indeed, for example on a clone with CLONE_VFORK, the right thing to do may be to borrow the parent's TLS.
            // Unfortunately, LLVM does not export __tls_base directly on dynamic libraries, so we go through a wrapper.
            instance.exports.__set_tls_base(tls_base);
          }
          user_executable_instance = instance;
          return instance;
        });

        return woken;
      };

      const user_executable_run = (instance) => {
        if (should_call_clone_callback) {
          // We have to reset this state, because if the clone callback calls exec, we have to run _start() instead!
          should_call_clone_callback = false;

          if (instance.exports.__libc_clone_callback) {
            instance.exports.__libc_clone_callback();
            throw new Error("Wasm function __libc_clone_callback() returned (it should never return)!");
          } else {
            throw new Error("Wasm function __libc_clone_callback() not defined!");
          }
        } else {
          if (instance.exports._start) {
            // Ideally libc would do this instead of the usual __init_array stuff (e.g. override __libc_start_init in
            // musl). However, a reference to __wasm_call_ctors becomes a GOT import in -fPIC code, perhaps rightfully
            // so with the current implementation and use case on LLVM. Anyway, we do it here, slightly early on...
            if (instance.exports.__wasm_call_ctors) {
              instance.exports.__wasm_call_ctors();
            }

            // TLS: somewhat incorrectly contains 0 instead of the TP before exec(). Since we will anyway not care about
            // its value (__wasm_apply_data_relocs() called would have overwritten it in this case) it does not matter.
            instance.exports._start();
            throw new Error("Wasm function _start() returned (it should never return)!");
          } else {
            throw new Error("Wasm function _start() not defined!");
          }
        }
      };

      const user_executable_error = (error) => {
        if (error instanceof Trap) {
          if (error.kind == "reload_program") {
            // Someone called exec and the currently executing code should stop. We should run the new user code already
            // loaded by wasm_load_executable().
            return user_executable_chain();
          } else if (error.kind == "panic") {
            // This has already been handled - just swallow it. This Worker will be done - but kept for later debugging.
          } else {
            throw new Error("Unexpected Wasm host Trap " + error.kind);
          }
        } else {
          wasm_error(error);
        }
      };

      const user_executable_chain = () => {
        // user_executable_error() may deal with an exec() trap and recursively call run_chain() again.
        return user_executable_setup().then(user_executable_run).catch(user_executable_error);
      };

      // All tasks start in the kernel, some return to userland, where they should never return. If they return, we
      // handle this as an error and wait. Our life ends when the kernel kills us by terminating the whole Worker. Oh,
      // and exex() can trap us, in which case we have to circle back to loading new user code and executing it agian.
      vmlinux_setup().then(vmlinux_run).catch(wasm_error).then(user_executable_chain);
    },
  };

  self.onmessage = (message_event) => {
    const data = message_event.data;
    message_callbacks[data.method](data);
  };

  self.onmessageerror = (error) => {
    throw error;
  };
})(console);
