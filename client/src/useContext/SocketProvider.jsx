import React, { createContext, useMemo, useContext } from "react";
import { io } from "socket.io-client";

const SocketContext = createContext(null);

export const useSocket = () => {  //custom hook
      const socket = useContext(SocketContext);
      return socket;
};

export const SocketProvider = (props) => {
      const socket = useMemo(() => {
            const URL = process.env.REACT_APP_SOCKET_SERVER_URL;

            return io(URL, {
                  transports: ["websocket"],
            });
      }, []);
      
      return (
            <SocketContext.Provider value={socket}>
                  {props.children}
            </SocketContext.Provider>
      );
};