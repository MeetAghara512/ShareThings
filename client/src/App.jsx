import './App.css';
import { Routes, Route } from 'react-router-dom';
import Lobby from './Pages/Lobby';
import Room from './Pages/Room';
import Left from './Pages/Left';
import { useLayoutEffect, useState } from 'react';
import { AuthProvider } from './useContext/AuthProvider';
import VersionBanner from './Pages/VersionBanner';

const THEME_KEY = "sharethings.theme";

function App() {
	const [darkMode, setDarkMode] = useState(() => localStorage.getItem(THEME_KEY) !== "light");

	useLayoutEffect(() => {
		document.documentElement.classList.toggle("light", !darkMode);
	}, [darkMode]);

	const toggleDarkMode = () => {
		localStorage.setItem(THEME_KEY, darkMode ? "light" : "dark");
		setDarkMode(!darkMode);
	};

	return (
		<div className="min-h-[100vh] bg-ground text-ink">
			<VersionBanner />
			<AuthProvider>
			<Routes>
				<Route path='/' element={<Lobby darkMode={darkMode} toggleDarkMode={toggleDarkMode} />} />
				<Route path='/room/:roomId' element={<Room darkMode={darkMode} toggleDarkMode={toggleDarkMode} />} />
				<Route path='/left/:roomId' element={<Left />} />
			</Routes>
			</AuthProvider>
		</div>
	);
}

export default App;
