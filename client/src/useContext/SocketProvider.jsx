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

            return io(URL, {
                  transports: ["websocket"],
            });
      }, []);

      const [status, setStatus] = useState(() => (socket.connected ? "connected" : "connecting"));
      const [attempt, setAttempt] = useState(0); // a retry starts the FAIL_AFTER wait again

      useEffect(() => {
            const update = () => setStatus(socket.connected ? "connected" : "connecting");
            socket.on("connect", update);
            socket.on("disconnect", update);
            return () => {
                  socket.off("connect", update);
                  socket.off("disconnect", update);
            };
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
