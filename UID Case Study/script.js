document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM fully loaded and parsed.");

    // --- CONFIGURATION ---
    const INTERSECTION_IDS = ['A', 'B', 'C'];
    const APPROACHES = ['N', 'S', 'E', 'W'];
    const BASE_GREEN_TIME = 8000; // ms
    const YELLOW_TIME = 2000; // ms
    const ALL_RED_PAUSE_TIME = 1000; // ms for pause if no demand or after yellow before next green
    const MAX_VEHICLES_PER_APPROACH = 50;
    const CONGESTION_THRESHOLD = 25; // Vehicles per approach to be considered congested
    const SIMULATION_TICK_RATE = 1000; // ms, for vehicle generation and global updates
    const VEHICLES_PROCESSED_PER_GREEN = 3; // Number of vehicles processed from an approach during its green phase

    // --- DOM ELEMENTS ---
    const startSimBtn = document.getElementById('start-simulation-btn');
    const stopSimBtn = document.getElementById('stop-simulation-btn');
    const resetSimBtn = document.getElementById('reset-simulation-btn');
    const overallCongestionEl = document.getElementById('overall-congestion');
    const activeIncidentsEl = document.getElementById('active-incidents');
    const simulationTimeEl = document.getElementById('simulation-time');
    const logMessagesEl = document.getElementById('log-messages');

    const eventIntersectionSelect = document.getElementById('event-intersection-select');
    const eventTypeSelect = document.getElementById('event-type-select');
    const eventApproachSelect = document.getElementById('event-approach-select');
    const triggerEventBtn = document.getElementById('trigger-event-btn');
    const clearEventsBtn = document.getElementById('clear-events-btn');

    if (!startSimBtn || !stopSimBtn || !resetSimBtn) {
        console.error("CRITICAL ERROR: One or more simulation control buttons not found. Check HTML IDs.");
        return; // Stop script if essential controls are missing
    } else {
        console.log("Control buttons (Start, Stop, Reset) found successfully.");
    }

    // --- SIMULATION STATE ---
    let simulationRunning = false;
    let globalTickInterval = null;
    let simTimeSeconds = 0;
    let intersections = {};
    let activeEvents = []; // { id, intersectionId, type, approach, description }

    // --- UTILITY FUNCTIONS ---
    function log(message, type = 'info') {
        const li = document.createElement('li');
        const timestamp = new Date().toLocaleTimeString();
        li.textContent = `[${timestamp}] ${message}`;
        if (type === 'error') li.style.color = '#E74C3C';
        if (type === 'warning') li.style.color = '#F39C12';
        if (logMessagesEl) {
            logMessagesEl.appendChild(li);
            logMessagesEl.scrollTop = logMessagesEl.scrollHeight;
            if (logMessagesEl.children.length > 50) {
                logMessagesEl.removeChild(logMessagesEl.firstChild);
            }
        } else {
            console.warn("Log messages element not found for message:", message);
        }
    }

    function formatTime(seconds) {
        const mins = Math.floor(seconds / 60).toString().padStart(2, '0');
        const secs = (seconds % 60).toString().padStart(2, '0');
        return `${mins}:${secs}`;
    }

    // --- INTERSECTION OBJECT FACTORY ---
    function createIntersection(id) {
        const intersection = {
            id: id,
            vehicleCounts: { N: 0, S: 0, E: 0, W: 0 },
            lightState: { ns: 'red', ew: 'red' }, // ns: 'red'/'yellow'/'green', ew: 'red'/'yellow'/'green'
            currentPhase: 'all_red', // 'ns_green', 'ns_yellow', 'ew_green', 'ew_yellow', 'all_red'
            cycleTimeout: null,
            isCongested: false,
            isBlockedByEvent: { N: false, S: false, E: false, W: false }, // true if blocked, false otherwise

            updateDOM: function() {
                APPROACHES.forEach(appr => {
                    const el = document.getElementById(`${this.id}-${appr}-vehicles`);
                    if (el) el.textContent = this.vehicleCounts[appr];
                });

                ['NS', 'EW'].forEach(dir => {
                    const redLight = document.getElementById(`${this.id}-${dir}-red`);
                    const yellowLight = document.getElementById(`${this.id}-${dir}-yellow`);
                    const greenLight = document.getElementById(`${this.id}-${dir}-green`);

                    if (redLight) redLight.classList.remove('active');
                    if (yellowLight) yellowLight.classList.remove('active');
                    if (greenLight) greenLight.classList.remove('active');

                    const currentDirLightState = (dir === 'NS') ? this.lightState.ns : this.lightState.ew;

                    if (currentDirLightState === 'red' && redLight) redLight.classList.add('active');
                    else if (currentDirLightState === 'yellow' && yellowLight) yellowLight.classList.add('active');
                    else if (currentDirLightState === 'green' && greenLight) greenLight.classList.add('active');
                });

                const statusEl = document.getElementById(`status-${this.id}`);
                if (statusEl) {
                    let currentStatus = 'Normal';
                    let statusClass = 'normal';
                    if (Object.values(this.isBlockedByEvent).some(blocked => blocked)) {
                        currentStatus = 'Incident'; statusClass = 'incident';
                    } else if (this.isCongested) {
                        currentStatus = 'Congested'; statusClass = 'congested';
                    }
                    statusEl.textContent = currentStatus;
                    statusEl.className = `status-indicator ${statusClass}`;
                }
            },

            runCycle: function() {
                if (!simulationRunning) return;
                clearTimeout(this.cycleTimeout);
                this.cycleTimeout = null;

                let nextPhase = 'all_red';
                let nextPhaseDuration = ALL_RED_PAUSE_TIME;

                switch (this.currentPhase) {
                    case 'ns_green':
                        nextPhase = 'ns_yellow';
                        nextPhaseDuration = YELLOW_TIME;
                        break;
                    case 'ns_yellow':
                        nextPhase = 'all_red_before_ew'; // Intermediate state to ensure all_red pause
                        nextPhaseDuration = ALL_RED_PAUSE_TIME;
                        break;
                    case 'ew_green':
                        nextPhase = 'ew_yellow';
                        nextPhaseDuration = YELLOW_TIME;
                        break;
                    case 'ew_yellow':
                        nextPhase = 'all_red_before_ns'; // Intermediate state
                        nextPhaseDuration = ALL_RED_PAUSE_TIME;
                        break;
                    case 'all_red':
                    case 'all_red_before_ew':
                    case 'all_red_before_ns':
                        const nsDemand = (this.vehicleCounts.N > 0 && !this.isBlockedByEvent.N) || (this.vehicleCounts.S > 0 && !this.isBlockedByEvent.S);
                        const ewDemand = (this.vehicleCounts.E > 0 && !this.isBlockedByEvent.E) || (this.vehicleCounts.W > 0 && !this.isBlockedByEvent.W);

                        if (this.currentPhase === 'all_red_before_ew' || (this.currentPhase === 'all_red' && ewDemand && !nsDemand) ) { // Prioritize EW if it was next or only one with demand
                            if (ewDemand) {
                                nextPhase = 'ew_green';
                                nextPhaseDuration = BASE_GREEN_TIME;
                            } else if (nsDemand) { // Fallback to NS if EW has no demand
                                nextPhase = 'ns_green';
                                nextPhaseDuration = BASE_GREEN_TIME;
                            } else {
                                nextPhase = 'all_red'; // Stay all_red if no demand
                                nextPhaseDuration = ALL_RED_PAUSE_TIME * 2; // Longer pause
                            }
                        } else { // Default to NS or if it was next
                             if (nsDemand) {
                                nextPhase = 'ns_green';
                                nextPhaseDuration = BASE_GREEN_TIME;
                            } else if (ewDemand) {
                                nextPhase = 'ew_green';
                                nextPhaseDuration = BASE_GREEN_TIME;
                            } else {
                                nextPhase = 'all_red';
                                nextPhaseDuration = ALL_RED_PAUSE_TIME * 2;
                            }
                        }
                        break;
                }
                
                this.setPhase(nextPhase);
                if (simulationRunning) {
                    this.cycleTimeout = setTimeout(() => this.runCycle(), nextPhaseDuration);
                }
            },

            setPhase: function(phase) {
                this.currentPhase = phase;
                switch(phase) {
                    case 'ns_green':
                        this.lightState = { ns: 'green', ew: 'red' };
                        if(!this.isBlockedByEvent.N) this.vehicleCounts.N = Math.max(0, this.vehicleCounts.N - VEHICLES_PROCESSED_PER_GREEN);
                        if(!this.isBlockedByEvent.S) this.vehicleCounts.S = Math.max(0, this.vehicleCounts.S - VEHICLES_PROCESSED_PER_GREEN);
                        break;
                    case 'ns_yellow':
                        this.lightState = { ns: 'yellow', ew: 'red' };
                        break;
                    case 'ew_green':
                        this.lightState = { ns: 'red', ew: 'green' };
                        if(!this.isBlockedByEvent.E) this.vehicleCounts.E = Math.max(0, this.vehicleCounts.E - VEHICLES_PROCESSED_PER_GREEN);
                        if(!this.isBlockedByEvent.W) this.vehicleCounts.W = Math.max(0, this.vehicleCounts.W - VEHICLES_PROCESSED_PER_GREEN);
                        break;
                    case 'ew_yellow':
                        this.lightState = { ns: 'red', ew: 'yellow' };
                        break;
                    case 'all_red':
                    case 'all_red_before_ns':
                    case 'all_red_before_ew':
                    default: // Includes intermediate all_red phases
                        this.lightState = { ns: 'red', ew: 'red' };
                        this.currentPhase = 'all_red'; // Normalize intermediate states for next cycle decision
                        break;
                }
                this.updateDOM();
            },

            generateVehicles: function() {
                APPROACHES.forEach(appr => {
                    if (this.isBlockedByEvent[appr]) return; // No vehicles arrive at a blocked approach

                    if (Math.random() < 0.25) { // Adjust arrival probability as needed
                        this.vehicleCounts[appr] = Math.min(MAX_VEHICLES_PER_APPROACH, this.vehicleCounts[appr] + 1);
                    }
                });
                this.checkCongestion();
                // updateDOM is called by globalTick after all generation
            },

            checkCongestion: function() {
                this.isCongested = APPROACHES.some(appr => 
                    this.vehicleCounts[appr] >= CONGESTION_THRESHOLD && !this.isBlockedByEvent[appr]
                );
            },
            
            reset: function() {
                clearTimeout(this.cycleTimeout);
                this.cycleTimeout = null;
                this.vehicleCounts = { N: 0, S: 0, E: 0, W: 0 };
                this.isCongested = false;
                this.isBlockedByEvent = { N: false, S: false, E: false, W: false };
                this.setPhase('all_red'); // Initial state
            }
        };
        intersection.reset();
        return intersection;
    }

    // --- SIMULATION CONTROL ---
    function initializeSimulation() {
        INTERSECTION_IDS.forEach(id => {
            intersections[id] = createIntersection(id);
        });
        updateGlobalStats();
        startSimBtn.disabled = false;
        stopSimBtn.disabled = true;
        resetSimBtn.disabled = false;
        log('Simulation initialized. Ready to start.');
    }

    function startSimulation() {
        if (simulationRunning) return;
        simulationRunning = true;
        log('Simulation Started.', 'info');

        startSimBtn.disabled = true;
        stopSimBtn.disabled = false;
        resetSimBtn.disabled = true;

        INTERSECTION_IDS.forEach(id => {
            if (intersections[id]) intersections[id].runCycle();
        });

        if (globalTickInterval) clearInterval(globalTickInterval);
        globalTickInterval = setInterval(globalTick, SIMULATION_TICK_RATE);
    }

    function stopSimulation(isResetting = false) {
        if (!simulationRunning && !isResetting) {
            startSimBtn.disabled = false;
            stopSimBtn.disabled = true;
            resetSimBtn.disabled = false;
            return;
        }
        simulationRunning = false;
        if (globalTickInterval) {
            clearInterval(globalTickInterval);
            globalTickInterval = null;
        }

        INTERSECTION_IDS.forEach(id => {
            if (intersections[id] && intersections[id].cycleTimeout) {
                clearTimeout(intersections[id].cycleTimeout);
                intersections[id].cycleTimeout = null;
            }
             if (isResetting && intersections[id]) {
                 intersections[id].setPhase('all_red'); // On reset, force all red
             }
        });

        startSimBtn.disabled = false;
        stopSimBtn.disabled = true;
        resetSimBtn.disabled = false;

        if (!isResetting) {
            log('Simulation Stopped.', 'warning');
        }
    }
    
    function resetSimulation() {
        stopSimulation(true); // Pass true to indicate it's part of reset
        simTimeSeconds = 0;
        activeEvents = [];
        if (logMessagesEl) logMessagesEl.innerHTML = '';

        INTERSECTION_IDS.forEach(id => {
            if (intersections[id]) intersections[id].reset();
        });
        updateGlobalStats();
        log('Simulation Reset to Initial State.');
    }

    function globalTick() {
        if (!simulationRunning) return;
        simTimeSeconds++;
        INTERSECTION_IDS.forEach(id => {
            if (intersections[id]) {
                intersections[id].generateVehicles();
                intersections[id].updateDOM(); // Update DOM after generation for all intersections
            }
        });
        updateGlobalStats();
    }

    function updateGlobalStats() {
        if (simulationTimeEl) simulationTimeEl.textContent = formatTime(simTimeSeconds);

        let congestedCount = 0;
        INTERSECTION_IDS.forEach(id => {
            if (intersections[id] && intersections[id].isCongested) {
                congestedCount++;
            }
        });
        let congestionLevel = "Low";
        if (INTERSECTION_IDS.length > 0) {
            const congestionRatio = congestedCount / INTERSECTION_IDS.length;
            if (congestionRatio > 0.66) congestionLevel = "High";
            else if (congestionRatio > 0.33) congestionLevel = "Medium";
        }
        if(overallCongestionEl) overallCongestionEl.textContent = `${congestionLevel} (${congestedCount}/${INTERSECTION_IDS.length} congested)`;
        if(activeIncidentsEl) activeIncidentsEl.textContent = activeEvents.length;
    }

    // --- EVENT HANDLING ---
    function triggerEvent() {
        if (!simulationRunning) {
            log("Start simulation to trigger events.", "warning");
            return;
        }
        const intersectionId = eventIntersectionSelect.value;
        const eventType = eventTypeSelect.value; // 'accident' or 'road_closure'
        const approach = eventApproachSelect.value;

        const eventId = `evt-${Date.now()}`;
        let description = `Event on ${approach} of Intersection ${intersectionId}: `;
        description += (eventType === 'accident') ? "Accident reported." : "Road closure initiated.";
        
        // Simplified: both events cause full blockage of the approach
        const newEvent = { id: eventId, intersectionId, type: eventType, approach, description };
        activeEvents.push(newEvent);
        
        const targetIntersection = intersections[intersectionId];
        if (targetIntersection) {
            targetIntersection.isBlockedByEvent[approach] = true; // Mark approach as fully blocked
            log(`EVENT: ${description}`, 'error');
            targetIntersection.checkCongestion(); // Re-evaluate congestion
            targetIntersection.updateDOM(); // Update status indicator
            clearTimeout(targetIntersection.cycleTimeout); // Force re-evaluation of light cycle
            targetIntersection.cycleTimeout = null;
            targetIntersection.runCycle(); // Restart cycle with new conditions
        }
        updateGlobalStats();
    }

    function clearAllEvents() {
        if (activeEvents.length === 0) {
            log("No active events to clear.", "info");
            return;
        }
        log(`Clearing ${activeEvents.length} active event(s).`, 'warning');
        activeEvents.forEach(event => {
            const targetIntersection = intersections[event.intersectionId];
            if (targetIntersection && targetIntersection.isBlockedByEvent[event.approach]) {
                 targetIntersection.isBlockedByEvent[event.approach] = false; // Unblock
                 targetIntersection.checkCongestion();
                 targetIntersection.updateDOM();
                 clearTimeout(targetIntersection.cycleTimeout);
                 targetIntersection.cycleTimeout = null;
                 targetIntersection.runCycle();
            }
        });
        activeEvents = [];
        updateGlobalStats();
    }

    // --- EVENT LISTENERS ---
    if (startSimBtn) startSimBtn.addEventListener('click', startSimulation);
    if (stopSimBtn) stopSimBtn.addEventListener('click', () => stopSimulation(false));
    if (resetSimBtn) resetSimBtn.addEventListener('click', resetSimulation);
    if (triggerEventBtn) triggerEventBtn.addEventListener('click', triggerEvent);
    if (clearEventsBtn) clearEventsBtn.addEventListener('click', clearAllEvents);

    document.querySelectorAll('header nav a').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            e.preventDefault();
            const targetId = this.getAttribute('href');
            if (targetId) {
                const targetElement = document.querySelector(targetId);
                if (targetElement) {
                    window.scrollTo({
                        top: targetElement.offsetTop - (document.querySelector('header')?.offsetHeight || 0),
                        behavior: 'smooth'
                    });
                }
            }
        });
    });

    // --- INITIALIZATION ---
    initializeSimulation();
});