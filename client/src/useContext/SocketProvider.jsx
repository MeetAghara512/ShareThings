import React, { createContext, useMemo, useContext, useState, useEffect, useCallback } from "react";
import { io } from "socket.io-client";

const SocketContext = createContext(null);
const SocketStatusContext = createContext({ status: "connecting", retry: () => {} });

// The free server sleeps when idle and takes up to a minute to wake up; not connected after this long, it counts as unreachable
const FAIL_AFTER = 75000;

export const useSocket = () => {  //custom hook
      const socket = useContext(SocketContext);
      return socket;
};

// { status, retry }: status is "connected", "connecting" (also while the server wakes up) or "failed" (not
// connected for FAIL_AFTER; Socket.IO keeps trying in the background). retry reconnects at once
export const useSocketStatus = () => useContext(SocketStatusContext);

export const SocketProvider = (props) => {
      const socket = useMemo(() => {
            const URL = import.meta.env.REACT_APP_SOCKET_SERVER_URL;

            // WebSocket first: one connection stays on one server copy, so several copies work without sticky
            // sessions. Long-polling only when a WebSocket cannot be opened (a proxy that blocks it); that
            // fallback needs a single copy or sticky sessions
            return io(URL, { transports: ["websocket", "polling"], tryAllTransports: true });
      }, []);

      const [status, setStatus] = useState(() => (socket.connected ? "connected" : "connecting"));
      const [attempt, setAttempt] = useState(0); // a retry starts the FAIL_AFTER wait again

      useEffect(() => {
            const update = () => setStatus(socket.connected ? "connected" : "connecting");
            socket.on("connect", update);
            socket.on("disconnect", update);
            update(); // it can connect just before this runs (seen in Safari's engine), and "connect" does not fire again
            return () => {
                  socket.off("connect", update);
                  socket.off("disconnect", update);
            };
      }, [socket]);

      // A WebSocket handshake that hangs instead of failing (some proxies do that) never falls back by itself: the
      // attempt only ends at the connect timeout, and the next one starts with WebSocket again. After such a timeout
      // this tab starts with long-polling. Quick failures (a sleeping or unreachable server) keep WebSocket first,
      // which several server copies without sticky sessions need
      useEffect(() => {
            const fallBack = err => {
                  if (err?.message === "timeout") socket.io.opts.transports = ["polling", "websocket"];
            };
            socket.on("connect_error", fallBack);
            return () => socket.off("connect_error", fallBack);
      }, [socket]);

      useEffect(() => {
            if (status !== "connecting") return;
            const id = setTimeout(() => setStatus(s => (s === "connecting" ? "failed" : s)), FAIL_AFTER);
            return () => clearTimeout(id);
      }, [status, attempt]);

      const retry = useCallback(() => {
            socket.disconnect().connect();
            setStatus("connecting");
            setAttempt(a => a + 1);
      }, [socket]);
      const connection = useMemo(() => ({ status, retry }), [status, retry]);

      return (
            <SocketContext.Provider value={socket}>
                  <SocketStatusContext.Provider value={connection}>
                        {props.children}
                  </SocketStatusContext.Provider>
            </SocketContext.Provider>
      );
};
